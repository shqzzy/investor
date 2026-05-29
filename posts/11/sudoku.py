from mip import Model, INTEGER, maximize, BINARY, xsum
import itertools

sudoku = [ 0,0,3,0,2,0,6,0,0,
           9,0,0,3,0,5,0,0,1,
           0,0,1,8,0,6,4,0,0,
           0,0,8,1,0,2,9,0,0,
           7,0,0,0,0,0,0,0,8,
           0,0,6,7,0,8,2,0,0,
           0,0,2,6,0,9,5,0,0,
           8,0,0,2,0,3,0,0,9,
           0,0,5,0,1,0,3,0,0,
         ]


m = Model("Sudoku")

# create a variable in range [0,9] for each field in the sudoku
allvars = [m.add_var(var_type=INTEGER, lb = 1, ub = 9) for _ in sudoku]

def get_cell_ids(cell_id):
    xs = (cell_id % 3)*3
    ys = (cell_id // 3)*3
    for dx in range(3):
        for dy in range(3):
            yield (xs+dx) + 9 * (ys+dy)

def get_cell(cell_id):
    return [allvars[i] for i in get_cell_ids(cell_id)]

def get_row(row_id):
    start = row_id*9
    return allvars[start:start+9]

def get_column(column_id):
    return [allvars[y*9+column_id] for y in range(9)]

# Add an x != y constraint to model m
def add_unequality(m, x, y):
    bvar = m.add_var(var_type=BINARY)
    m += x <= y - 1 + 10 * bvar
    m += x >= y + 1 - 10 * (1-bvar)

# Fix constants
for (i, var) in zip(sudoku,allvars):
    if i != 0:
        m += var == i

# All columns, rows, and cells must be distinct
for i in range(9):
    [add_unequality(m, x, y) for (x,y) in itertools.combinations(get_column(i), 2)]
    [add_unequality(m, x, y) for (x,y) in itertools.combinations(get_row(i), 2)]
    [add_unequality(m, x, y) for (x,y) in itertools.combinations(get_cell(i), 2)]

# arbitrary
m.objective = maximize(allvars[0])

print(m.optimize(max_seconds=10))

if m.num_solutions:
    for y in range(9):
        for x in range(9):
            print(f"{int(allvars[y*9+x].x)},", end="")
        print()
