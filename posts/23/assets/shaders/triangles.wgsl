// Vertex + Fragment shader for rasterizing triangles
// Reads triangle data from a storage buffer, positions them in a 4x3 grid

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

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> triangles: array<f32>;

const FLOATS_PER_TRIANGLE: u32 = #{FLOATS_PER_TRIANGLE}u;

struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) color: vec4<f32>,
}

@vertex
fn vs_main(@builtin(vertex_index) vertex_index: u32) -> VertexOutput {
    // Each triangle has 3 vertices, figure out which triangle and which vertex
    let tri_global = vertex_index / 3u;
    let vert_in_tri = vertex_index % 3u;

    // Which SA instance does this triangle belong to?
    let instance = tri_global / params.num_triangles;
    let tri_local = tri_global % params.num_triangles;

    let off = (instance * params.num_triangles + tri_local) * FLOATS_PER_TRIANGLE;

    // Read vertex position (normalized 0..1)
    let vx = triangles[off + vert_in_tri * 2u + 0u];
    let vy = triangles[off + vert_in_tri * 2u + 1u];

    // Read per-vertex color: v0 RGB at [6..8], v1 RGB at [9..11], v2 RGB at [12..14], shared alpha at [15]
    let c_off = off + 6u + vert_in_tri * 3u;
    let r = triangles[c_off + 0u];
    let g = triangles[c_off + 1u];
    let b = triangles[c_off + 2u];
    let a = triangles[off + 15u];

    // Compute grid cell position
    let grid_col = instance % params.grid_cols;
    let grid_row = instance / params.grid_cols;

    // Convert from [0,1] triangle coords to pixel coords within the grid cell,
    // then to NDC [-1,1] across the full output texture
    let pixel_x = f32(grid_col * params.img_w) + vx * f32(params.img_w);
    let pixel_y = f32(grid_row * params.img_h) + vy * f32(params.img_h);

    let ndc_x = (pixel_x / f32(params.total_w)) * 2.0 - 1.0;
    // Flip Y: NDC has Y up, but our pixel coords have Y down
    let ndc_y = 1.0 - (pixel_y / f32(params.total_h)) * 2.0;

    var out: VertexOutput;
    out.position = vec4<f32>(ndc_x, ndc_y, 0.0, 1.0);
    out.color = vec4<f32>(r, g, b, a);
    return out;
}

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
    return in.color;
}
