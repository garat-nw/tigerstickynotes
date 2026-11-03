# tigerstickynotes
Yellow sticky note based project trackier, but tigery.

Pretty simple, uses Tauri 2 to package the app, and written in Rust by Claude because writing in Rust hurts my soul, but it worked for this. 

Basic whiteboard style project tracking:

Top level: Projects
Mid Level: White boards (Epics)
Lowest Level: Sticky Notes (Tasks)

Stores locally, designed to work with Proton drive sync API. If you don't use Proton, feel free to branch and make a version that uses the cloud storage (or other) you prefer. This was my use case.

Whiteboards store / author in JSON saved to Proton, however, each whiteboard can point at a local path on your computer you're running on, to create a markdown version of the whiteboard for doing things like Ralph loops with a coding agent.

Use it in good health, if you like it, let me know, if you expand on it, awesome, and have fun. 
