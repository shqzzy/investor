from mip import Model, minimize

m = Model("Balanced Life")

(x, y) = (m.add_var(), m.add_var())

m += x*30 + y*5  >= 50
m += x*40 + y*70 >= 100
m += x*25 + y*10 >= 30

m.objective = minimize(x*60 + y*20)

m.optimize()

print(f"Optimal solution: x = {x.x}, y={y.x}")

