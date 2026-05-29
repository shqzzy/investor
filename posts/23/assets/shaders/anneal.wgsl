// Simulated annealing compute shader
// Only handles: mutate, score (compare rendered vs target), decide
// Triangle rendering is done by the rasterization pipeline

const NUM_TRIANGLES: u32 = #{NUM_TRIANGLES}u;
const FLOATS_PER_TRIANGLE: u32 = #{FLOATS_PER_TRIANGLE}u;
const IMG_W: u32 = #{IMG_W}u;
const IMG_H: u32 = #{IMG_H}u;
const MAX_ITERATIONS: u32 = #{MAX_ITERATIONS}u;
const NUM_INSTANCES: u32 = #{NUM_INSTANCES}u;
const FINAL_TEMP: f32 = 0.00001;
const STATE_SIZE: u32 = #{STATE_SIZE}u;

struct Params {
    img_w: u32,
    img_h: u32,
    num_triangles: u32,
    num_instances: u32,
    grid_cols: u32,
    grid_rows: u32,
    total_w: u32,
    total_h: u32,
}

// Shared bindings (group 0) - same layout for all compute entry points
@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read_write> triangles: array<f32>;
@group(0) @binding(2) var<storage, read_write> state: array<f32>;
@group(0) @binding(3) var target_tex: texture_2d<f32>;
@group(0) @binding(4) var rendered_tex: texture_2d<f32>;
@group(0) @binding(5) var<storage, read_write> scores: array<atomic<u32>>;
@group(0) @binding(6) var<storage, read_write> prev_scores: array<u32>;

// ---- RNG (PCG) ----
fn pcg_hash(input: u32) -> u32 {
    var s = input * 747796405u + 2891336453u;
    var word = ((s >> ((s >> 28u) + 4u)) ^ s) * 277803737u;
    return (word >> 22u) ^ word;
}

fn rand_f32(rng: ptr<function, u32>) -> f32 {
    *rng = pcg_hash(*rng);
    return f32(*rng) / 4294967295.0;
}

fn rand_u32(rng: ptr<function, u32>) -> u32 {
    *rng = pcg_hash(*rng);
    return *rng;
}

fn get_triangle_offset(instance: u32, tri_idx: u32) -> u32 {
    return (instance * NUM_TRIANGLES + tri_idx) * FLOATS_PER_TRIANGLE;
}

fn get_state_offset(instance: u32) -> u32 {
    return instance * STATE_SIZE;
}

// ---- PASS 1: Mutate one random triangle per instance ----
@compute @workgroup_size(1)
fn mutate(@builtin(global_invocation_id) gid: vec3<u32>) {
    let instance = gid.x;
    if instance >= NUM_INSTANCES {
        return;
    }

    let s_off = get_state_offset(instance);
    var rng = bitcast<u32>(state[s_off + 0u]);
    let iteration = bitcast<u32>(state[s_off + 1u]);

    if iteration >= MAX_ITERATIONS {
        return;
    }

    // Pick a random triangle
    let tri_idx = rand_u32(&rng) % NUM_TRIANGLES;
    let t_off = get_triangle_offset(instance, tri_idx);

    // Temperature: exponential cooling — T = FINAL_TEMP^(iteration/MAX_ITERATIONS)
    // Equivalent to geometric cooling with rate = FINAL_TEMP^(1/MAX_ITERATIONS)
    let temperature = exp(log(FINAL_TEMP) * f32(iteration) / f32(MAX_ITERATIONS));
    state[s_off + 4u] = temperature;

    // Mutation strength proportional to temperature
    let mutation_strength = 0.1 * temperature + 0.005;

    // Pick mutation type: 0=vertex, 1=color, 2=alpha, 3=swap order, 4=randomize
    let mutation_type = rand_u32(&rng) % 5u;

    // Store packed: (mutation_type << 16) | tri_idx
    state[s_off + 5u] = bitcast<f32>((mutation_type << 16u) | tri_idx);

    if mutation_type == 3u {
        // Swap draw order: pick a second triangle and swap all their data
        var tri_idx_b = rand_u32(&rng) % NUM_TRIANGLES;
        // Make sure we pick a different triangle
        if tri_idx_b == tri_idx {
            tri_idx_b = (tri_idx + 1u) % NUM_TRIANGLES;
        }
        // Store second index in backup slot
        state[s_off + 6u] = bitcast<f32>(tri_idx_b);

        let t_off_b = get_triangle_offset(instance, tri_idx_b);
        // Swap all floats between the two triangles
        for (var i = 0u; i < FLOATS_PER_TRIANGLE; i++) {
            let tmp = triangles[t_off + i];
            triangles[t_off + i] = triangles[t_off_b + i];
            triangles[t_off_b + i] = tmp;
        }
    } else {
        // Save backup in state[s_off + 6..22]
        for (var i = 0u; i < FLOATS_PER_TRIANGLE; i++) {
            state[s_off + 6u + i] = triangles[t_off + i];
        }

        if mutation_type == 0u {
            // Mutate a vertex position
            let vertex = rand_u32(&rng) % 3u;
            let v_off = t_off + vertex * 2u;
            triangles[v_off + 0u] = clamp(triangles[v_off + 0u] + (rand_f32(&rng) - 0.5) * mutation_strength * 2.0, 0.0, 1.0);
            triangles[v_off + 1u] = clamp(triangles[v_off + 1u] + (rand_f32(&rng) - 0.5) * mutation_strength * 2.0, 0.0, 1.0);
        } else if mutation_type == 1u {
            // Mutate one vertex's color: 50% palette sample, 50% random nudge
            let vertex = rand_u32(&rng) % 3u;
            let c_off = t_off + 6u + vertex * 3u;
            let use_palette = (rand_u32(&rng) & 1u) == 0u;
            if use_palette {
                let sample_x = rand_u32(&rng) % IMG_W;
                let sample_y = rand_u32(&rng) % IMG_H;
                let sampled = textureLoad(target_tex, vec2<i32>(i32(sample_x), i32(sample_y)), 0);
                let blend = mutation_strength * 2.0;
                triangles[c_off + 0u] = clamp(mix(triangles[c_off + 0u], sampled.r, blend), 0.0, 1.0);
                triangles[c_off + 1u] = clamp(mix(triangles[c_off + 1u], sampled.g, blend), 0.0, 1.0);
                triangles[c_off + 2u] = clamp(mix(triangles[c_off + 2u], sampled.b, blend), 0.0, 1.0);
            } else {
                let channel = rand_u32(&rng) % 3u;
                triangles[c_off + channel] = clamp(triangles[c_off + channel] + (rand_f32(&rng) - 0.5) * mutation_strength * 2.0, 0.0, 1.0);
            }
        } else if mutation_type == 2u {
            // Mutate alpha (shared across vertices)
            triangles[t_off + 15u] = clamp(triangles[t_off + 15u] + (rand_f32(&rng) - 0.5) * mutation_strength, 0.02, 0.3);
        } else {
            // Randomize entire triangle: pick center + radius (biased small)
            let cx = rand_f32(&rng);
            let cy = rand_f32(&rng);
            let radius = rand_f32(&rng) * rand_f32(&rng) * 0.5;
            for (var v = 0u; v < 3u; v++) {
                triangles[t_off + v * 2u] = clamp(cx + (rand_f32(&rng) - 0.5) * radius * 2.0, 0.0, 1.0);
                triangles[t_off + v * 2u + 1u] = clamp(cy + (rand_f32(&rng) - 0.5) * radius * 2.0, 0.0, 1.0);
            }
            // Per-vertex colors: 50% palette sample, 50% fully random
            for (var v = 0u; v < 3u; v++) {
                let c_off = t_off + 6u + v * 3u;
                let use_palette = (rand_u32(&rng) & 1u) == 0u;
                if use_palette {
                    let sample_x = rand_u32(&rng) % IMG_W;
                    let sample_y = rand_u32(&rng) % IMG_H;
                    let sampled = textureLoad(target_tex, vec2<i32>(i32(sample_x), i32(sample_y)), 0);
                    triangles[c_off + 0u] = sampled.r;
                    triangles[c_off + 1u] = sampled.g;
                    triangles[c_off + 2u] = sampled.b;
                } else {
                    triangles[c_off + 0u] = rand_f32(&rng);
                    triangles[c_off + 1u] = rand_f32(&rng);
                    triangles[c_off + 2u] = rand_f32(&rng);
                }
            }
            triangles[t_off + 15u] = rand_f32(&rng) * 0.28 + 0.02;
        }
    }

    // Save RNG state back
    state[s_off + 0u] = bitcast<f32>(rng);

    // Reset score accumulator for this instance
    atomicStore(&scores[instance], 0u);
}

// Linear to sRGB conversion (for perceptual-space scoring)
fn linear_to_srgb(c: f32) -> f32 {
    if c <= 0.0031308 {
        return c * 12.92;
    }
    return 1.055 * pow(c, 1.0 / 2.4) - 0.055;
}

// ---- PASS 2 (after rasterization): Score by comparing rendered vs target ----
// Dispatched as (ceil(IMG_W/8), ceil(IMG_H/8), NUM_INSTANCES)
// Each workgroup handles one 8x8 tile for one instance.
// Uses workgroup-local reduction to minimize atomic contention.
var<workgroup> wg_error: atomic<u32>;

@compute @workgroup_size(8, 8)
fn score(
    @builtin(global_invocation_id) gid: vec3<u32>,
    @builtin(local_invocation_index) local_idx: u32,
) {
    let px = gid.x;
    let py = gid.y;
    let instance = gid.z;

    // First thread in workgroup initializes the shared accumulator
    if local_idx == 0u {
        atomicStore(&wg_error, 0u);
    }
    workgroupBarrier();

    if px < IMG_W && py < IMG_H && instance < NUM_INSTANCES {
        let s_off = get_state_offset(instance);
        let iteration = bitcast<u32>(state[s_off + 1u]);

        if iteration < MAX_ITERATIONS {
            let target_color = textureLoad(target_tex, vec2<i32>(i32(px), i32(py)), 0);

            // Read the rendered pixel from the correct grid cell
            let grid_col = instance % params.grid_cols;
            let grid_row = instance / params.grid_cols;
            let out_x = i32(grid_col * IMG_W + px);
            let out_y = i32(grid_row * IMG_H + py);

            let rendered_color = textureLoad(rendered_tex, vec2<i32>(out_x, out_y), 0);

            // textureLoad on sRGB textures returns linear values;
            // convert both to sRGB for perceptually uniform comparison
            let dr = linear_to_srgb(rendered_color.r) - linear_to_srgb(target_color.r);
            let dg = linear_to_srgb(rendered_color.g) - linear_to_srgb(target_color.g);
            let db = linear_to_srgb(rendered_color.b) - linear_to_srgb(target_color.b);
            let dr2 = dr * dr;
            let dg2 = dg * dg;
            let db2 = db * db;
            // Perceptual weights (Rec. 601 luminance coefficients), compared in sRGB space
            let pixel_error = 0.299 * dr2 * dr2 + 0.587 * dg2 * dg2 + 0.114 * db2 * db2;

            let error_int = u32(pixel_error * 10000.0);
            // Accumulate into workgroup-local atomic (much less contention)
            atomicAdd(&wg_error, error_int);
        }
    }

    workgroupBarrier();

    // One thread per workgroup adds the local sum to the global score
    if local_idx == 0u && instance < NUM_INSTANCES {
        let local_sum = atomicLoad(&wg_error);
        if local_sum > 0u {
            atomicAdd(&scores[instance], local_sum);
        }
    }
}

// ---- PASS 3: Accept/reject and advance iteration ----
@compute @workgroup_size(1)
fn decide(@builtin(global_invocation_id) gid: vec3<u32>) {
    let instance = gid.x;
    if instance >= NUM_INSTANCES {
        return;
    }

    let s_off = get_state_offset(instance);
    var rng = bitcast<u32>(state[s_off + 0u]);
    let iteration = bitcast<u32>(state[s_off + 1u]);

    if iteration >= MAX_ITERATIONS {
        return;
    }

    let new_score = atomicLoad(&scores[instance]);
    let old_score = prev_scores[instance];
    let temperature = state[s_off + 4u];
    let packed = bitcast<u32>(state[s_off + 5u]);
    let mutation_type = packed >> 16u;
    let tri_idx = packed & 0xFFFFu;

    var accept = false;

    if new_score <= old_score {
        accept = true;
    } else {
        let delta = f32(new_score) - f32(old_score);
        let effective_temp = max(temperature * 5000.0, 0.001);
        let prob = exp(-delta / effective_temp);
        let r = rand_f32(&rng);
        if r < prob {
            accept = true;
        }
    }

    if accept {
        prev_scores[instance] = new_score;
        state[s_off + 2u] = bitcast<f32>(new_score);
        let best_score = bitcast<u32>(state[s_off + 3u]);
        if new_score < best_score {
            state[s_off + 3u] = bitcast<f32>(new_score);
        }
    } else {
        // Revert the mutation
        if mutation_type == 3u {
            // Swap revert: just swap the two triangles back
            let tri_idx_b = bitcast<u32>(state[s_off + 6u]);
            let t_off_a = get_triangle_offset(instance, tri_idx);
            let t_off_b = get_triangle_offset(instance, tri_idx_b);
            for (var i = 0u; i < FLOATS_PER_TRIANGLE; i++) {
                let tmp = triangles[t_off_a + i];
                triangles[t_off_a + i] = triangles[t_off_b + i];
                triangles[t_off_b + i] = tmp;
            }
        } else {
            // Restore from backup
            let t_off = get_triangle_offset(instance, tri_idx);
            for (var i = 0u; i < FLOATS_PER_TRIANGLE; i++) {
                triangles[t_off + i] = state[s_off + 6u + i];
            }
        }
    }

    // Advance iteration
    state[s_off + 1u] = bitcast<f32>(iteration + 1u);
    state[s_off + 0u] = bitcast<f32>(rng);
}
