
import os
import json
import socket
import threading
import webbrowser
import time
from pathlib import Path
from datetime import datetime, timezone

from flask import Flask, render_template, request, jsonify
from dotenv import load_dotenv


# CONFIGURATION


BASE_DIR = Path(__file__).resolve().parent
load_dotenv(BASE_DIR / ".env")

app = Flask(
    __name__,
    template_folder=str(BASE_DIR / "templates"),
    static_folder=str(BASE_DIR / "static")
)

app.secret_key = os.getenv(
    "FLASK_SECRET_KEY",
    "local-development-only-change-this"
)

app.config["MAX_CONTENT_LENGTH"] = 12 * 1024 * 1024

DEMO_FILE = BASE_DIR / "demo_sessions.json"


# LOCAL DEMO STORAGE


def read_demo():
    try:
        data = json.loads(
            DEMO_FILE.read_text(encoding="utf-8")
        )
        return data if isinstance(data, list) else []
    except (OSError, json.JSONDecodeError):
        return []


def write_demo(items):
    temporary_file = DEMO_FILE.with_suffix(".tmp")

    temporary_file.write_text(
        json.dumps(items[-100:], indent=2, ensure_ascii=False),
        encoding="utf-8"
    )

    temporary_file.replace(DEMO_FILE)


# SECURITY HEADERS


@app.after_request
def security_headers(response):
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
    response.headers["X-Frame-Options"] = "DENY"

    response.headers["Permissions-Policy"] = (
        "camera=(self), microphone=(self), geolocation=(self)"
    )

    return response

# HOME PAGE

@app.route("/")
def home():
    html_file = BASE_DIR / "templates" / "index.html"

    if not html_file.is_file():
        return (
            "<h1>RecoveryAI could not find index.html</h1>"
            "<p>Place your HTML file inside the templates folder.</p>"
            "<p>Expected path: templates/index.html</p>",
            500
        )

    return render_template(
        "index.html",
        supabase_url=os.getenv("SUPABASE_URL", ""),
        supabase_anon_key=os.getenv("SUPABASE_ANON_KEY", ""),
        default_emergency=os.getenv(
            "DEFAULT_EMERGENCY_NUMBER", "112"
        )
    )


@app.route("/health")
def health():
    return jsonify({
        "status": "running",
        "application": "RecoveryAI"
    })


@app.route("/api/config")
def config():
    return jsonify({
        "openai_ready": bool(os.getenv("OPENAI_API_KEY")),
        "gemini_ready": bool(os.getenv("GEMINI_API_KEY")),
        "supabase_ready": bool(
            os.getenv("SUPABASE_URL")
            and os.getenv("SUPABASE_ANON_KEY")
        ),
        "default_provider": os.getenv(
            "DEFAULT_AI_PROVIDER", "openai"
        )
    })


# SAVE DEMO SESSION

@app.route("/api/session", methods=["POST"])
def save_session():
    data = request.get_json(silent=True) or {}

    item = {
        "created_at": datetime.now(timezone.utc).isoformat(),
        "observations": data.get("observations", {}),
        "notes": str(data.get("notes", ""))[:1000]
    }

    try:
        items = read_demo()
        items.append(item)
        write_demo(items)

    except OSError:
        app.logger.exception("Could not save session")

        return jsonify({
            "error": "Could not save the local demo session."
        }), 500

    return jsonify({
        "ok": True,
        "session": item,
        "storage": "local-demo",
        "notice": (
            "Local demonstration storage only. "
            "Secure authenticated storage is required for real patient records."
        )
    })


# AI SAFETY INSTRUCTIONS

SYSTEM_PROMPT = """
You are RecoveryAI, a cautious stroke-recovery companion, not a doctor.

Use simple, supportive language.

Do not diagnose stroke, nerve damage, facial swelling causes, or breathing
disorders. Never interpret an AI observation as proof that someone is safe.

Do not prescribe, stop, or change medicines.

For laboratory reports, explain only the values actually supplied. Respect
units and reference ranges, explain uncertainty, and suggest questions for
the user's clinician. Never invent missing results.

Sudden new facial drooping, one-sided weakness, speech difficulty, severe
breathing difficulty, collapse, or chest pain may be an emergency. Tell the
user to seek emergency help immediately and not to wait for an AI scan.
In India, call 112.

Never claim that an ordinary camera can measure blood pressure or see nerves.
"""

# OPENAI CONNECTION

def openai_chat(prompt, system):
    key = os.getenv("OPENAI_API_KEY", "").strip()

    if not key or key == "your_real_api_key":
        raise RuntimeError(
            "OpenAI is not configured. Add your real API key to "
            "OPENAI_API_KEY in the .env file, save it, and restart app.py."
        )

    from openai import OpenAI

    client = OpenAI(api_key=key)

    result = client.responses.create(
        model=os.getenv("OPENAI_MODEL", "gpt-4.1-mini"),
        instructions=system,
        input=prompt
    )

    return result.output_text or "I could not generate a response."

# GEMINI CONNECTION

def gemini_chat(prompt, system):
    key = os.getenv("GEMINI_API_KEY", "").strip()

    if not key or key == "your_real_api_key":
        raise RuntimeError(
            "Gemini is not configured. Add your real API key to "
            "GEMINI_API_KEY in the .env file, save it, and restart app.py."
        )

    from google import genai

    client = genai.Client(api_key=key)
    model = os.getenv("GEMINI_MODEL", "gemini-3.8-flash").strip() or "gemini-3.8-flash"
    # Automatically migrate the exact model ID used by the older starter project.
    if model == "gemini-2.5-flash":
        model = "gemini-3.8-flash"
    full_input = system + "\n\nUser request:\n" + prompt

    # Use the current Interactions API, with a compatibility fallback for
    # installed SDK versions that do not expose it yet.
    interactions = getattr(client, "interactions", None)
    if interactions is not None and hasattr(interactions, "create"):
        result = interactions.create(model=model, input=full_input)
        answer = getattr(result, "output_text", None)
        if answer:
            return answer

    result = client.models.generate_content(model=model, contents=full_input)
    return getattr(result, "text", None) or "I could not generate a response."


# SELECT AI PROVIDER

def get_ai_response(prompt, provider):
    if provider == "openai":
        return openai_chat(prompt, SYSTEM_PROMPT)

    if provider == "gemini":
        return gemini_chat(prompt, SYSTEM_PROMPT)

    raise ValueError("Choose OpenAI or Gemini.")

# AI CHAT

@app.route("/api/chat", methods=["POST"])
def chat():
    data = request.get_json(silent=True) or {}

    prompt = str(data.get("message", "")).strip()[:6000]

    provider = str(
        data.get(
            "provider",
            os.getenv("DEFAULT_AI_PROVIDER", "openai")
        )
    ).lower()

    if not prompt:
        return jsonify({
            "error": "Enter a message first."
        }), 400

    try:
        answer = get_ai_response(prompt, provider)

        return jsonify({
            "response": answer,
            "provider": provider
        })

    except Exception as exc:
        app.logger.exception("AI chat failed")
        message = str(exc)
        lower = message.lower()
        if "api key" in lower or "authentication" in lower or "401" in lower:
            message = f"{provider.title()} authentication failed. Check that the {provider.upper()}_API_KEY in .env is correct, active, and belongs to that provider."
        elif "quota" in lower or "billing" in lower or "429" in lower:
            message = f"{provider.title()} rejected the request because of quota or billing limits. Check that provider's API usage and billing settings."
        elif "model" in lower and ("404" in lower or "not found" in lower or "no longer available" in lower):
            message = f"The selected {provider.title()} model is unavailable. Check the model setting in .env; for Gemini use GEMINI_MODEL=gemini-3.8-flash."
        return jsonify({"error": message}), 503

# LAB REPORT EXPLANATION

@app.route("/api/report-explain", methods=["POST"])
def report_explain():
    data = request.get_json(silent=True) or {}

    report_text = str(
        data.get("report_text", "")
    ).strip()[:12000]

    provider = str(
        data.get(
            "provider",
            os.getenv("DEFAULT_AI_PROVIDER", "openai")
        )
    ).lower()

    if not report_text:
        return jsonify({
            "error": "Paste or extract report text first."
        }), 400

    prompt = (
        "Explain this laboratory report in plain language. Do not diagnose. "
        "Separate the values and units visible in the supplied text, what "
        "they commonly mean, and questions to ask a clinician. Do not invent "
        "missing values. If reference ranges are absent, say so.\n\n"
        "REPORT TEXT:\n" + report_text
    )

    try:
        answer = get_ai_response(prompt, provider)

        return jsonify({
            "response": answer,
            "provider": provider,
            "notice": (
                "This explanation is informational only. "
                "A qualified clinician should review the report."
            )
        })

    except Exception as exc:
        app.logger.exception("Report explanation failed")

        return jsonify({
            "error": str(exc)
        }), 503

# SPEECH TRANSCRIPTION

@app.route("/api/transcribe", methods=["POST"])
def transcribe():
    key = os.getenv("OPENAI_API_KEY", "").strip()

    if not key:
        return jsonify({
            "error": "OpenAI API key is not configured in .env."
        }), 503

    upload = request.files.get("audio")

    if not upload:
        return jsonify({
            "error": "No audio file received."
        }), 400

    try:
        from openai import OpenAI

        client = OpenAI(api_key=key)

        transcript = client.audio.transcriptions.create(
            model="gpt-4o-mini-transcribe",
            file=(
                upload.filename or "speech.webm",
                upload.stream,
                upload.mimetype or "audio/webm"
            )
        )

        return jsonify({
            "text": transcript.text
        })

    except Exception as exc:
        app.logger.exception("Transcription failed")

        return jsonify({
            "error": str(exc)
        }), 503

# FIND AN AVAILABLE PORT

def port_available(host, port):
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.settimeout(0.5)

        return sock.connect_ex((host, port)) != 0


def find_free_port(host, start=5000, end=5010):
    for port in range(start, end + 1):
        if port_available(host, port):
            return port

    return None

# AUTOMATICALLY OPEN THE BROWSER

def open_recoveryai(url):
    time.sleep(1.5)

    try:
        # Try common Chrome installation locations on Windows.
        chrome_paths = [
            os.path.expandvars(
                r"%ProgramFiles%\Google\Chrome\Application\chrome.exe"
            ),
            os.path.expandvars(
                r"%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"
            ),
            os.path.expandvars(
                r"%LocalAppData%\Google\Chrome\Application\chrome.exe"
            )
        ]

        for chrome_path in chrome_paths:
            if os.path.isfile(chrome_path):
                browser = webbrowser.BackgroundBrowser(chrome_path)
                browser.open(url, new=1)
                return

        # Fall back to the computer's default browser.
        webbrowser.open(url, new=2)

    except Exception as exc:
        print("Could not automatically open the browser:", exc)

    print("\nIf the browser does not open, copy this address into Chrome:")
    print(url)

# START RECOVERYAI

def main():
    host = os.getenv("HOST", "127.0.0.1")

    configured_port = os.getenv("PORT", "").strip()

    if configured_port:
        try:
            port = int(configured_port)
        except ValueError:
            raise SystemExit(
                "Invalid PORT in .env. Use a number such as PORT=5000."
            )

        if not port_available(host, port):
            raise SystemExit(
                f"Port {port} is already in use. Stop the other app "
                "or change PORT in your .env file."
            )

    else:
        port = find_free_port(host)

        if port is None:
            raise SystemExit(
                "Ports 5000-5010 are busy. Close other RecoveryAI "
                "windows and try again."
            )

    html_file = BASE_DIR / "templates" / "index.html"

    if not html_file.is_file():
        print("\nERROR: RecoveryAI cannot find its HTML page.")
        print("Expected location:", html_file)
        print("Your folder should contain:")
        print("  app.py")
        print("  templates/index.html")
        raise SystemExit(1)

    url = f"http://127.0.0.1:{port}"

    print("\n" + "=" * 48)
    print("          RECOVERYAI IS STARTING")
    print("=" * 48)
    print("Opening your browser automatically...")
    print("If it does not open, visit:")
    print(url)
    print("\nKeep this window open while using RecoveryAI.")
    print("Press CTRL+C to stop the app.")
    print("=" * 48 + "\n")

    threading.Thread(
        target=open_recoveryai,
        args=(url,),
        daemon=True
    ).start()

    app.run(
        host=host,
        port=port,
        debug=False,
        use_reloader=False,
        threaded=True
    )


if __name__ == "__main__":
    try:
        main()

    except KeyboardInterrupt:
        print("\nRecoveryAI has been stopped.")

    except ModuleNotFoundError as exc:
        print(f"\nMissing Python package: {exc.name}")
        print(
            "Install the required packages by running:\n"
            "python -m pip install flask python-dotenv requests openai google-genai"
        )

    except Exception as exc:
        print("\nRecoveryAI could not start:", exc)
        raise
