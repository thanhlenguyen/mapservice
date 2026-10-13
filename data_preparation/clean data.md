Below is the clear, step-by-step guide to split polylines at every intersection point in QGIS, including dealing with messy/unsnapped data like yours.

Here is the exact QGIS Model Builder workflow to automate all steps:

✔ Fix geometries
✔ Snap lines
✔ Detect intersections
✔ Clean duplicates
✔ Split lines at intersections
✔ (Optional) Reproject / measure / clean small segments


🎯 STEP-BY-STEP — CREATE THE MODEL
1️⃣ Open Model Builder

QGIS Menu:
Processing → Graphical Modeler…

Click: New Model

Model Name: Split Lines at Intersections

Group: Custom Tools

2️⃣ Add the Input Layer

Left panel → “Inputs”

Choose: Vector Layer
Name it: input_lines

This is what the user selects when running the model.

3️⃣ Add Fix Geometries

Left panel → “Toolbox”
Search: Fix Geometries

Double-click it →

Input layer: input_lines
Output name: fixed

4️⃣ Add Snap Geometries to Layer

Toolbox: Snap Geometries to Layer

Parameters:

Input layer: fixed

Reference layer: fixed

Tolerance:

If WGS84 (EPSG:4326): 0.00002

If projected: 1–2 meters

Behavior: Vertex and segment

Output name: snapped

3️⃣ Add Fix Geometries again

Left panel → “Toolbox”
Search: Fix Geometries

Double-click it →

Input layer: snapped
Output name: fixed1

5️⃣ Add Line Intersections

Toolbox: Line Intersections

Parameters:

Input layer: fixed1

Overlay layer: fixed1

Include all intersection types: YES

Input fields to keep: none

Overlay fields to keep: none

Output name: intersections

6️⃣ Add Delete Duplicate Geometries

Toolbox: Delete Duplicate Geometries

Parameters:

Input layer: intersections

Output name: intersections_cleaned

7️⃣ Add Split Lines with Points

Toolbox: Split Lines with Points

Parameters:

Input layer: snapped

Split layer: intersections_cleaned

Tolerance:

WGS84: 0.00002

Projected: 1–2 m

Output name: split_lines

8️⃣ Add Model Output

Left panel → “Outputs”

Choose: Vector Layer

Name it: final_output
Choose type: “Line”

This output = split_lines

🎉 DONE!

You now have a fully automated pipeline.

🚀 BONUS: Optional advanced steps

You can add any of these:

(A) Reproject to a metric CRS

Algorithm: Reproject Layer
Target CRS: EPSG:3857 or your zone (e.g., 32638 for KSA)

(B) Calculate line length

Algorithm: Field Calculator
Expression:

$length

(C) Delete very small segments

Algorithm: Extract by Expression (or by Attribute)
Expression:

$length > 1


I can add these into the model for you if you want the full topology-ready version for PgRouting.