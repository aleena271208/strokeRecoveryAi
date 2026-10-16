RECOVERYAI — REPAIRED STARTER PROJECT
=====================================

IMPORTANT: This repair is based on the app.py and index.html you uploaded.
It adds the missing static/app.js browser code and makes camera preview
independent from MediaPipe model loading. It tries more than one CDN.
A network/CDN block can still prevent face landmarks from loading.

WINDOWS QUICK START
-------------------
1. Extract this ZIP into a normal folder.
2. Open Command Prompt in that folder.
3. Run: python -m pip install -r requirements.txt
4. Copy .env.example to a new file named .env.
5. Add your own OpenAI or Gemini API key to .env.
   Keep the key private. Do not send it to anyone.
6. Run: python app.py
7. Open the local address printed by the app if Chrome does not open.

REQUIRED FOLDER LAYOUT
----------------------
app.py
requirements.txt
.env
templates/index.html
static/app.js

CAMERA
------
Use the local address http://127.0.0.1:5000 (or the port printed by app.py)
in Chrome. Allow camera permission. Do not open index.html by double-clicking.
The camera preview should start even if the face model CDN is unavailable.
Face landmark observations still require the MediaPipe module, WASM files,
and model asset to download successfully.

AI
--
Chat/report explanation requires a valid configured API key and internet.
In Settings, choose the provider matching the key you configured.
If neither key is configured, AI cannot produce real AI responses.

SAFETY
------
This is a demo, not a medical device. Do not rely on camera observations
to diagnose a stroke or decide whether a person is safe. In India, call
112 for a suspected emergency.


LATEST FEATURES / SECURITY
- Use the Complete scan button to record face landmark and head movement observations in one five-second session.
- Use Stop speaking to immediately cancel the browser's spoken response.
- The camera cannot measure breathing rate. Guided breathing is a separate exercise.
- Never paste API keys into chat or share them. If a key was exposed, revoke it and create a replacement.
- OpenAI API access requires an active key and available API billing/quota; a ChatGPT plan alone does not guarantee API usage.
- “AI cloning” is not enabled by this package. If you mean cloning your own voice, that requires a voice-cloning provider and a sample/consent flow; if you mean copying an AI’s personality and instructions, that is a different feature.
