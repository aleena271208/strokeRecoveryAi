const $ = id => document.getElementById(id);
let faceLandmarker = null, cameraStream = null, cameraLoop = false, latestFace = null;
let reminders = [];
let sessionHistory = [];
const CONFIG = window.RECOVERY_CONFIG || {};

function say(text) {
  if (!$("voiceReplies")?.checked && $("voiceReplies")) return;
  if ("speechSynthesis" in window) {
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.rate = 0.95;
    speechSynthesis.speak(u);
  }
}
function stopSpeaking() {
  if ("speechSynthesis" in window) window.speechSynthesis.cancel();
}
$("stopSpeaking")?.addEventListener("click", stopSpeaking);

function showApp() {
  const splash = $("splash");
  const shell = $("appShell");
  if (splash) splash.classList.add("hidden");
  if (shell) shell.classList.remove("hidden");
  document.body.classList.add("app-open");
  loadLocalSettings();
  window.scrollTo({ top: 0, behavior: "auto" });
}
$("enterApp").addEventListener("click", showApp);
window.addEventListener("load", () => {
  // Keep the welcome screen until Continue is clicked.
  $("emergencyNumber").value = localStorage.getItem("rai_emergency") || CONFIG.defaultEmergency || "112";
  updateAIStatus();
  $("sessionHistory").innerHTML = "<p class='small-note'>No sessions saved in this browser yet.</p>";
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("/static/sw.js").catch(()=>{});
});
function loadLocalSettings() {
  const on = localStorage.getItem("rai_assistant_mode") === "true";
  $("assistantToggle").checked = on;
  applyAssistantMode(on);
  $("voiceReplies").checked = localStorage.getItem("rai_voice_replies") !== "false";
}
function applyAssistantMode(on) {
  if (!on) stopSpeaking();
  $("assistantPanel").classList.toggle("hidden", !on);
  $("assistantModeBtn").textContent = "Assistant mode: " + (on ? "On" : "Off");
  $("assistantToggle").checked = on;
}
$("assistantModeBtn").addEventListener("click", () => {
  const next = localStorage.getItem("rai_assistant_mode") !== "true";
  localStorage.setItem("rai_assistant_mode", String(next));
  applyAssistantMode(next);
});
$("settingsBtn").addEventListener("click", () => $("settingsPanel").classList.toggle("hidden"));
$("closeSettings").addEventListener("click", () => $("settingsPanel").classList.add("hidden"));
$("assistantToggle").addEventListener("change", e => {
  localStorage.setItem("rai_assistant_mode", String(e.target.checked));
  applyAssistantMode(e.target.checked);
});
$("voiceReplies").addEventListener("change", e => localStorage.setItem("rai_voice_replies", String(e.target.checked)));

async function importVisionModule() {
  const urls = [
    "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.22/vision_bundle.mjs",
    "https://unpkg.com/@mediapipe/tasks-vision@0.10.22/vision_bundle.mjs",
    "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.21/vision_bundle.mjs"
  ];
  let lastError;
  for (const url of urls) {
    try {
      const module = await import(url);
      if (module.FilesetResolver && module.FaceLandmarker) {
        console.info("MediaPipe vision module loaded from", url);
        return module;
      }
      throw new Error("MediaPipe module did not contain the expected exports.");
    } catch (error) {
      console.warn("MediaPipe module source failed:", url, error);
      lastError = error;
    }
  }
  throw lastError || new Error("All MediaPipe module sources failed.");
}

async function initFace() {
  if (faceLandmarker) return faceLandmarker;
  $("cameraOverlayMessage").textContent = "Camera is on. Loading face-observation model…";
  const module = await importVisionModule();
  const wasmBases = [
    "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.22/wasm",
    "https://unpkg.com/@mediapipe/tasks-vision@0.10.22/wasm",
    "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.21/wasm"
  ];
  let lastError;
  for (const wasmBase of wasmBases) {
    try {
      const vision = await module.FilesetResolver.forVisionTasks(wasmBase);
      faceLandmarker = await module.FaceLandmarker.createFromOptions(vision, {
        baseOptions: {
          modelAssetPath: "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task"
        },
        runningMode: "VIDEO",
        numFaces: 1,
        outputFaceBlendshapes: true
      });
      console.info("Face observation model initialized.");
      return faceLandmarker;
    } catch (error) {
      console.warn("MediaPipe WASM/model initialization failed from", wasmBase, error);
      lastError = error;
    }
  }
  throw lastError || new Error("Could not initialize the face-observation model.");
}

async function startCamera() {
  if (cameraStream) {
    if (!faceLandmarker) {
      try {
        await initFace();
        if (!cameraLoop) { cameraLoop = true; requestAnimationFrame(processFrame); }
        $("cameraOverlayMessage").textContent = "Face the camera in good lighting";
      } catch (error) {
        console.warn("Face model retry failed:", error);
        $("cameraOverlayMessage").textContent = "Camera is on; face model could not load. Check internet/CDN access.";
      }
    }
    return;
  }
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    alert("This browser does not allow camera access here. Open RecoveryAI at http://127.0.0.1:5000 in an updated Chrome browser.");
    return;
  }
  try {
    // Start the camera independently so a CDN/model outage cannot block the preview.
    cameraStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: "user", width: { ideal: 1280 } },
      audio: false
    });
    $("camera").srcObject = cameraStream;
    await $("camera").play();
    $("cameraStatus").textContent = "Camera on";
    $("cameraOverlayMessage").textContent = "Camera preview is running. Loading observation model…";
    cameraLoop = true;
    requestAnimationFrame(processFrame);

    try {
      await initFace();
      $("cameraOverlayMessage").textContent = "Face the camera in good lighting";
    } catch (modelError) {
      console.error("Camera is running, but face model could not load:", modelError);
      $("cameraOverlayMessage").textContent = "Camera is working; face model unavailable. Check internet/CDN.";
      $("faceStatus").textContent = "Model unavailable — no observation made";
      alert("The camera is on, but the face-observation model could not download. The rest of RecoveryAI remains usable. Check your internet connection or network restrictions.");
    }
  } catch (error) {
    console.error("Camera start failed:", error);
    if (cameraStream) cameraStream.getTracks().forEach(track => track.stop());
    cameraStream = null;
    $("camera").srcObject = null;
    $("cameraStatus").textContent = "Camera off";
    $("cameraOverlayMessage").textContent = "Camera could not start. Check permission and close other apps using it.";
    alert("Camera could not start: " + (error.message || error.name || "Unknown error") +
      ". Check Chrome site permissions and close other apps using the camera.");
  }
}
function stopCamera() {
  cameraLoop = false;
  if (cameraStream) cameraStream.getTracks().forEach(t=>t.stop());
  cameraStream = null;
  $("camera").srcObject = null;
  $("cameraStatus").textContent = "Camera off";
  $("cameraOverlayMessage").textContent = "Camera is off";
  const c=$("overlay"), ctx=c.getContext("2d"); ctx.clearRect(0,0,c.width,c.height);
}
function processFrame() {
  if (!cameraLoop || !$("camera").videoWidth) return;
  try {
    const video=$("camera"), canvas=$("overlay"), ctx=canvas.getContext("2d");
    canvas.width=video.videoWidth; canvas.height=video.videoHeight;
    ctx.clearRect(0,0,canvas.width,canvas.height);
    const res=faceLandmarker.detectForVideo(video, performance.now());
    if (res.faceLandmarks?.length) {
      latestFace=res.faceLandmarks[0];
      ctx.fillStyle="#8de0d2";
      for (let i=0;i<latestFace.length;i+=5) {
        const p=latestFace[i]; ctx.beginPath(); ctx.arc(p.x*canvas.width,p.y*canvas.height,2,0,Math.PI*2); ctx.fill();
      }
      $("cameraOverlayMessage").textContent="Face landmarks detected";
    } else {
      latestFace=null; $("cameraOverlayMessage").textContent="Move into view of the camera";
    }
  } catch(e) { console.warn(e); }
  requestAnimationFrame(processFrame);
}
$("startCamera").addEventListener("click", startCamera);
$("stopCamera").addEventListener("click", stopCamera);
window.addEventListener("beforeunload", stopCamera);

function pointDist(a,b){return Math.hypot(a.x-b.x,a.y-b.y);}
$("faceCheck").addEventListener("click", async () => {
  if (!$("camera").srcObject) await startCamera();
  if (!faceLandmarker) { alert("Face-observation model is not available. The camera preview may still work; check internet/CDN access and try again."); return; }
  if (!latestFace) { alert("No face landmarks detected yet. Face the camera and try again."); return; }
  const f=latestFace;
  const leftEye=f[33], rightEye=f[263], leftMouth=f[61], rightMouth=f[291];
  const eye=pointDist(leftEye,rightEye);
  // Rotate the mouth-corner delta against the eye line to reduce camera-roll effects.
  const dx=rightEye.x-leftEye.x, dy=rightEye.y-leftEye.y;
  const angle=Math.atan2(dy,dx);
  const mouthDx=rightMouth.x-leftMouth.x, mouthDy=rightMouth.y-leftMouth.y;
  const correctedVertical=Math.abs(-Math.sin(angle)*mouthDx+Math.cos(angle)*mouthDy);
  const normalized=eye>0 ? correctedVertical/eye*100 : null;
  // Geometry only: lighting, pose, camera angle, and natural variation affect this value.
  $("faceStatus").textContent = normalized !== null ? `Face landmarks detected; mouth-corner height difference ${normalized.toFixed(1)}% of eye distance` : "Face landmarks detected; unable to calculate a comparison";
  $("puffinessStatus").textContent = "Not measured";
  $("breathingStatus").textContent = "Not clinically assessed";
  $("cameraOverlayMessage").textContent="Observation recorded — not a diagnosis";
  say("Face observation recorded.");
});
$("headCheck").addEventListener("click", async () => {
  if (!$("camera").srcObject) await startCamera();
  if (!faceLandmarker) { alert("Face-observation model is not available. The camera preview may still work; check internet/CDN access and try again."); return; }
  if (!latestFace) { alert("No face detected yet."); return; }
  const start=performance.now(), vals=[];
  $("headStatus").textContent="Recording movement for 5 seconds…";
  $("cameraOverlayMessage").textContent="Keep shoulders comfortable; slowly turn your head left and right only if safe and comfortable.";
  while(performance.now()-start<5000) {
    if(latestFace) {
      const f=latestFace, eye=pointDist(f[33],f[263]);
      if(eye>0) vals.push((f[1].x-(f[33].x+f[263].x)/2)/eye);
    }
    await new Promise(r=>setTimeout(r,100));
  }
  if(vals.length<10) {$("headStatus").textContent="Insufficient face tracking; keep your face visible and try again";return;}
  const span=(Math.max(...vals)-Math.min(...vals))*100;
  $("headStatus").textContent=`Tracked nose-to-eye-midpoint horizontal range: ${span.toFixed(1)}% of eye distance`;
  $("cameraOverlayMessage").textContent="Movement observation complete";
});
async function completeScan() {
  const button = $("completeScan");
  button.disabled = true;
  button.textContent = "Scanning… keep face visible";
  try {
    if (!$("camera").srcObject) await startCamera();
    if (!faceLandmarker) await initFace();
    if (!latestFace) throw new Error("No face detected. Face the camera in good lighting and try again.");

    // Record the current face landmark comparison first.
    const f = latestFace;
    const leftEye = f[33], rightEye = f[263], leftMouth = f[61], rightMouth = f[291];
    const eye = pointDist(leftEye, rightEye);
    const dx = rightEye.x - leftEye.x, dy = rightEye.y - leftEye.y;
    const angle = Math.atan2(dy, dx);
    const mouthDx = rightMouth.x - leftMouth.x, mouthDy = rightMouth.y - leftMouth.y;
    const correctedVertical = Math.abs(-Math.sin(angle) * mouthDx + Math.cos(angle) * mouthDy);
    const normalized = eye > 0 ? correctedVertical / eye * 100 : null;
    $("faceStatus").textContent = normalized !== null
      ? `Face landmarks found; mouth-corner height difference ${normalized.toFixed(1)}% of eye distance`
      : "Face landmarks found; comparison unavailable";

    // Track head position during one combined five-second scan.
    const start = performance.now(), vals = [];
    $("cameraOverlayMessage").textContent = "Complete scan: keep your face visible and gently turn left/right only if comfortable";
    while (performance.now() - start < 5000) {
      if (latestFace) {
        const landmarks = latestFace;
        const eyeDistance = pointDist(landmarks[33], landmarks[263]);
        if (eyeDistance > 0) vals.push((landmarks[1].x - (landmarks[33].x + landmarks[263].x) / 2) / eyeDistance);
      }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    if (vals.length >= 10) {
      const span = (Math.max(...vals) - Math.min(...vals)) * 100;
      $("headStatus").textContent = `Head movement tracked; horizontal range ${span.toFixed(1)}% of eye distance`;
    } else {
      $("headStatus").textContent = "Not enough face tracking; try again in good lighting";
    }
    $("puffinessStatus").textContent = "Not assessed in this scan";
    $("breathingStatus").textContent = "Breathing rate not measured by camera";
    $("cameraOverlayMessage").textContent = "Complete face + head scan finished";
    say("Complete scan finished. Review the face and head observations on screen.");
  } catch (error) {
    $("cameraOverlayMessage").textContent = error.message || "Scan could not finish";
    alert(error.message || "Scan could not finish. Check the camera and face model.");
  } finally {
    button.disabled = false;
    button.textContent = "Complete scan (face + head)";
  }
}
$("completeScan")?.addEventListener("click", completeScan);

let breathingTimer = null;
let breathingPhaseIndex = 0;
const breathingPhases = [
  { label: "Breathe in gently", seconds: 4 },
  { label: "Breathe out slowly", seconds: 6 }
];
function stopBreathingGuide() {
  if (breathingTimer) clearInterval(breathingTimer);
  breathingTimer = null;
  breathingPhaseIndex = 0;
  if ($("breathingStart")) $("breathingStart").disabled = false;
  if ($("breathingStop")) $("breathingStop").disabled = true;
  if ($("breathingGuide")) $("breathingGuide").textContent = "Guided breathing stopped. This does not measure breathing rate or diagnose a breathing problem.";
  if ($("breathingStatus")) $("breathingStatus").textContent = "Guided exercise stopped; rate not measured";
}
function startBreathingGuide() {
  stopBreathingGuide();
  let secondsLeft = breathingPhases[0].seconds;
  $("breathingStart").disabled = true;
  $("breathingStop").disabled = false;
  const update = () => {
    const phase = breathingPhases[breathingPhaseIndex];
    $("breathingGuide").textContent = `${phase.label} · ${secondsLeft}s remaining. Keep it comfortable; do not hold your breath.`;
    $("breathingStatus").textContent = `${phase.label} (guided exercise only; breathing not measured)`;
    secondsLeft -= 1;
    if (secondsLeft < 0) {
      breathingPhaseIndex = (breathingPhaseIndex + 1) % breathingPhases.length;
      secondsLeft = breathingPhases[breathingPhaseIndex].seconds;
    }
  };
  update();
  breathingTimer = setInterval(update, 1000);
}
$("breathingStart")?.addEventListener("click", startBreathingGuide);
$("breathingStop")?.addEventListener("click", stopBreathingGuide);
window.addEventListener("beforeunload", () => { if (breathingTimer) clearInterval(breathingTimer); });

function speechListen() {
  const SR=window.SpeechRecognition||window.webkitSpeechRecognition;
  if(!SR){alert("Browser speech recognition is unavailable. Try Chrome or upload an audio recording.");return;}
  const r=new SR(); r.lang="en-IN"; r.interimResults=false;
  $("speechResult").textContent="Listening. Say: Today I am working on my recovery.";
  r.onresult=e=>{const text=e.results[0][0].transcript; $("speechResult").textContent="Transcript: "+text+" (transcription only; not a clinical speech score)."; say("I captured your speech. Review the transcript and discuss concerns with your clinician.");};
  r.onerror=e=>$("speechResult").textContent="Speech capture failed: "+e.error;
  r.start();
}
$("speechCheck").addEventListener("click", speechListen);
$("transcribeUpload").addEventListener("click", ()=>$("audioFile").click());
$("audioFile").addEventListener("change", async e=>{
  const file=e.target.files[0]; if(!file)return;
  const fd=new FormData(); fd.append("audio",file);
  $("speechResult").textContent="Transcribing...";
  try{const res=await fetch("/api/transcribe",{method:"POST",body:fd});const data=await res.json();$("speechResult").textContent=data.text||data.error;}catch(err){$("speechResult").textContent="Transcription failed: "+err.message;}
});
function addBubble(text,who) {const d=document.createElement("div");d.className="bubble "+who;d.textContent=text;$("chatLog").appendChild(d);$("chatLog").scrollTop=$("chatLog").scrollHeight;}
async function updateAIStatus() {
  const status = $("aiStatus");
  if (!status) return;
  try {
    const response = await fetch("/api/config", { cache: "no-store" });
    const config = await response.json();
    const selected = $("provider")?.value || config.default_provider || "openai";
    const ready = selected === "gemini" ? config.gemini_ready : config.openai_ready;
    status.textContent = ready
      ? `${selected === "gemini" ? "Gemini" : "OpenAI"} is configured. Send a message to test it.`
      : `AI is not connected yet: add your ${selected === "gemini" ? "GEMINI_API_KEY" : "OPENAI_API_KEY"} to the .env file, save it, and restart the app.`;
  } catch (_) {
    status.textContent = "AI status unavailable. Make sure the Python app is running and refresh this page.";
  }
}
$("provider").addEventListener("change", updateAIStatus);
async function sendChatText(message) {
  addBubble(message,"user");
  const button = $("sendChat");
  button.disabled = true;
  button.textContent = "Thinking…";
  try {
    const res=await fetch("/api/chat",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({message,provider:$("provider").value})});
    const data=await res.json();
    const answer=data.response||data.error||`AI request failed (HTTP ${res.status}).`;
    addBubble(answer,"ai");
    if (data.response) say(answer);
    updateAIStatus();
  } catch(e) {addBubble("Could not reach the server. Check that the Python app is running, then refresh this page.", "ai");}
  finally { button.disabled = false; button.textContent = "Send"; }
}
$("sendChat").addEventListener("click",()=>{const v=$("chatInput").value.trim();if(v){$("chatInput").value="";sendChatText(v);}});
$("chatInput").addEventListener("keydown",e=>{if(e.key==="Enter")$("sendChat").click();});
function voiceCommand() {
  stopSpeaking();
  const SR=window.SpeechRecognition||window.webkitSpeechRecognition;
  if(!SR){alert("Voice input is not available in this browser.");return;}
  const r=new SR();r.lang="en-IN";r.interimResults=false;r.onresult=e=>{
    const t=e.results[0][0].transcript.toLowerCase();
    if(t.includes("face")) $("faceCheck").click();
    else if(t.includes("head")||t.includes("neck")) $("headCheck").click();
    else if(t.includes("speech")) $("speechCheck").click();
    else if(t.includes("emergency")) $("emergencyNow").click();
    else if(t.includes("hospital")) $("findHospitals").click();
    else sendChatText(t);
  };r.start();say("I'm listening.");
}
$("startVoice").addEventListener("click",voiceCommand);
$("assistantMic").addEventListener("click",voiceCommand);

$("medicineForm").addEventListener("submit",e=>{
  e.preventDefault();
  const item={name:$("medicineName").value.trim(),time:$("medicineTime").value,instructions:$("medicineInstructions").value.trim()};
  reminders.push(item); localStorage.setItem("rai_medicines",JSON.stringify(reminders)); renderMedicines(); e.target.reset();
});
function renderMedicines(){
  const wrap=$("medicineList");wrap.innerHTML="";
  reminders.forEach((m,i)=>{const d=document.createElement("div");d.className="medicine-item";d.textContent=`${m.time} — ${m.name}${m.instructions?" · "+m.instructions:""}`;
  const b=document.createElement("button");b.className="secondary";b.textContent="Remove";b.addEventListener("click",()=>{reminders.splice(i,1);localStorage.setItem("rai_medicines",JSON.stringify(reminders));renderMedicines();});d.appendChild(document.createElement("br"));d.appendChild(b);wrap.appendChild(d);});
}
try{reminders=JSON.parse(localStorage.getItem("rai_medicines")||"[]");}catch{} renderMedicines();
// Browser reminders are best-effort and only run while this page is open.
setInterval(()=>{
  const now=new Date(), hh=String(now.getHours()).padStart(2,"0"), mm=String(now.getMinutes()).padStart(2,"0"), key=`${now.toDateString()} ${hh}:${mm}`;
  reminders.forEach(m=>{if(m.time===`${hh}:${mm}` && localStorage.getItem("rai_last_reminder")!==key+" "+m.name){localStorage.setItem("rai_last_reminder",key+" "+m.name);alert("Medicine reminder: "+m.name+"\nFollow your prescribed instructions. Do not change your dose based on this app.");}});
},15000);

$("reportFile").addEventListener("change",e=>{$("reportFileName").textContent=e.target.files[0]?.name||"";});
$("explainReport").addEventListener("click",async()=>{
  const text=$("reportText").value.trim();if(!text){alert("Paste the report text first. File text extraction is not enabled in this starter.");return;}
  $("reportAnswer").classList.remove("hidden");$("reportAnswer").textContent="Preparing explanation...";
  try{const res=await fetch("/api/report-explain",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({report_text:text,provider:$("provider").value})});const data=await res.json();$("reportAnswer").textContent=(data.response||data.error||"No response")+(data.notice?"\n\n"+data.notice:"");}catch(e){$("reportAnswer").textContent="Could not reach the server.";}
});
$("findHospitals").addEventListener("click",()=>window.open("https://www.google.com/maps/search/hospitals+near+me","_blank","noopener"));
$("saveEmergency").addEventListener("click",()=>{const n=$("emergencyNumber").value.trim();if(!n){alert("Enter your local emergency number first.");return;}localStorage.setItem("rai_emergency",n);alert("Emergency number saved on this device. Verify it is correct for your location.");});
$("callEmergency").addEventListener("click",()=>{const n=$("emergencyNumber").value.trim();if(!n){alert("Set an emergency number first.");return;}if(confirm("Open the phone dialer for "+n+"? You must confirm/place the call yourself."))window.location.href="tel:"+n.replace(/[^\d+]/g,"");});
$("emergencyNow").addEventListener("click",()=>{const n=$("emergencyNumber").value.trim()||CONFIG.defaultEmergency||"112";if(confirm("If symptoms are sudden or severe, seek emergency help now. Open the phone dialer for "+n+"?"))window.location.href="tel:"+n.replace(/[^\d+]/g,"");else window.open("https://www.google.com/maps/search/hospitals+near+me","_blank","noopener");});
$("saveSession").addEventListener("click",async()=>{
  const observations={face:$("faceStatus").textContent,head:$("headStatus").textContent,puffiness:$("puffinessStatus").textContent,breathing:$("breathingStatus").textContent};
  try{const res=await fetch("/api/session",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({observations,notes:$("sessionNotes").value})});const data=await res.json();sessionHistory.unshift(data.session);renderHistory();alert("Saved to local demo history. Configure Supabase before using shared patient accounts.");}catch(e){alert("Could not save session.");}
});
function renderHistory(){const el=$("sessionHistory");el.innerHTML="";sessionHistory.slice(0,5).forEach(s=>{const d=document.createElement("div");d.className="history-item";d.textContent=new Date(s.created_at).toLocaleString()+" — "+(s.notes||"No notes")+"\n"+Object.entries(s.observations).map(([k,v])=>k+": "+v).join(" · ");el.appendChild(d);});}
