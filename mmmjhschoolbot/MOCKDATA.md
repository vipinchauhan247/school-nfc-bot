# mockData.js — do not delete

`index.html` loads `js/mockData.js` first. It must define `const SchoolData = { ... }`.

| Wrong | Right |
|--------|--------|
| Delete `mockData.js` completely | Site breaks (`SchoolData is not defined`) |
| Keep huge demo students/staff file | Mock staff flash on refresh |
| Upload empty shell `mockData.js` from this branch | Structure only; real staff/students from cloud |

Upload the small `js/mockData.js` from PR #8 (empty `students` / `staffUsers` / `teachers`) and bump `?v=`.
