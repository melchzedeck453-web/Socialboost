import os
import json
import time
import uuid
import threading
import requests
import telebot
from telebot import types

# =========================
# CONFIG
# =========================

TOKEN = os.getenv("BOT_TOKEN", "Token-Here")

bot = telebot.TeleBot(TOKEN, parse_mode="HTML")

DOWNLOAD_DIR = "downloads"
STATE_FILE = "download_state.json"

os.makedirs(DOWNLOAD_DIR, exist_ok=True)

# Per-user/session state
user_states = {}
state_lock = threading.Lock()


# =========================
# HELPERS
# =========================

def safe_request(method, url, **kwargs):
    """
    HTTP request with a default timeout and error handling.
    """
    kwargs.setdefault("timeout", 30)

    try:
        response = requests.request(method, url, **kwargs)
        response.raise_for_status()
        return response
    except requests.RequestException as e:
        print(f"[HTTP ERROR] {url}: {e}")
        return None


def create_session(chat_id):
    """
    Creates an isolated download session for a user.
    """
    session_id = uuid.uuid4().hex

    with state_lock:
        user_states[session_id] = {
            "chat_id": chat_id,
            "urls": {},
            "created": time.time()
        }

    return session_id


def save_url(chat_id, quality, url):
    """
    Stores a URL in an isolated session.
    """
    session_id = create_session(chat_id)

    with state_lock:
        user_states[session_id]["urls"][quality] = url

    return session_id


def add_url(session_id, quality, url):
    with state_lock:
        if session_id in user_states:
            user_states[session_id]["urls"][quality] = url


def get_url(session_id, quality):
    with state_lock:
        session = user_states.get(session_id)

        if not session:
            return None

        return session["urls"].get(quality)


def delete_session(session_id):
    with state_lock:
        user_states.pop(session_id, None)


def cleanup_file(path):
    try:
        if path and os.path.exists(path):
            os.remove(path)
    except Exception as e:
        print(f"[CLEANUP ERROR] {e}")


def cleanup_old_files():
    """
    Removes files older than one hour.
    """
    try:
        now = time.time()

        for filename in os.listdir(DOWNLOAD_DIR):
            path = os.path.join(DOWNLOAD_DIR, filename)

            if not os.path.isfile(path):
                continue

            if now - os.path.getmtime(path) > 3600:
                cleanup_file(path)

    except Exception as e:
        print(f"[OLD FILE CLEANUP ERROR] {e}")


def send_error(chat_id, text="Download failed. Please try again."):
    try:
        bot.send_message(chat_id, f"❌ {text}")
    except Exception as e:
        print(f"[TELEGRAM ERROR] {e}")


# =========================
# START
# =========================

@bot.message_handler(commands=["start"])
def start(message):
    bot.reply_to(
        message,
        "👋 Welcome!\n\n"
        "🔗 Send me a video URL to download."
    )


# =========================
# URL ROUTER
# =========================

@bot.message_handler(func=lambda message: True)
def whizzy(message):

    if not message.text:
        return

    url = message.text.strip()
    lower_url = url.lower()

    try:

        if "instagram.com" in lower_url:
            Instagram(message)

        elif "youtu.be" in lower_url or "youtube.com" in lower_url:
            YouTube(message)

        elif "tiktok.com" in lower_url:
            TikTok(message)

        elif "facebook.com" in lower_url or "fb.watch" in lower_url:
            Facebook(message)

        else:
            bot.reply_to(
                message,
                "❌ Unsupported URL.\n\n"
                "Please send a supported video link."
            )

    except Exception as e:
        print(f"[ROUTER ERROR] {e}")
        send_error(message.chat.id)


# =========================
# INSTAGRAM
# =========================

def Instagram(message):

    chat_id = message.chat.id
    link = message.text.strip()

    msg = bot.reply_to(
        message,
        "🔎 Searching Instagram...\n"
        "⏳ Please wait."
    )

    headers = {
        "authority": "www.y2mate.com",
        "accept": "*/*",
        "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
        "origin": "https://www.y2mate.com",
        "referer": "https://www.y2mate.com/instagram-downloader",
        "user-agent": (
            "Mozilla/5.0 (Linux; Android 10; K) "
            "AppleWebKit/537.36 "
            "(KHTML, like Gecko) Chrome/116.0.0.0 "
            "Mobile Safari/537.36"
        ),
        "x-requested-with": "XMLHttpRequest",
    }

    data = {
        "k_query": link,
        "k_page": "Instagram",
        "hl": "en",
        "q_auto": "1",
    }

    response = safe_request(
        "POST",
        "https://www.y2mate.com/mates/analyzeV2/ajax",
        headers=headers,
        data=data
    )

    if not response:
        send_error(chat_id, "Instagram service is currently unavailable.")
        return

    try:
        result = response.json()

        video_url = (
            result
            .get("links", {})
            .get("video", [{}])[0]
            .get("url")
        )

    except Exception as e:
        print(f"[INSTAGRAM PARSE ERROR] {e}")
        send_error(chat_id, "Could not process this Instagram URL.")
        return

    if not video_url:
        send_error(chat_id, "No downloadable video was found.")
        return

    session_id = save_url(
        chat_id,
        "insta",
        video_url
    )

    markup = types.InlineKeyboardMarkup()

    button = types.InlineKeyboardButton(
        "🎬 High Quality",
        callback_data=f"download|{session_id}|insta"
    )

    markup.add(button)

    bot.send_message(
        chat_id,
        "🎞️ Choose the video quality:",
        reply_markup=markup
    )


# =========================
# FACEBOOK
# =========================

def Facebook(message):

    chat_id = message.chat.id
    link = message.text.strip()

    bot.reply_to(
        message,
        "🔎 Searching Facebook...\n"
        "⏳ Please wait."
    )

    headers = {
        "authority": "social-downloader.vercel.app",
        "accept": "application/json, text/plain, */*",
        "referer": "https://social-downloader.vercel.app/facebook",
        "user-agent": (
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
            "AppleWebKit/537.36 "
            "(KHTML, like Gecko) Chrome/116.0.0.0 "
            "Safari/537.36"
        ),
    }

    response = safe_request(
        "GET",
        "https://social-downloader.vercel.app/api/facebook",
        params={"url": link},
        headers=headers
    )

    if not response:
        send_error(chat_id, "Facebook service is currently unavailable.")
        return

    try:
        result = response.json()
    except Exception as e:
        print(f"[FACEBOOK JSON ERROR] {e}")
        send_error(chat_id, "Could not process this Facebook URL.")
        return

    high = result.get("links", {}).get(
        "Download High Quality",
        ""
    )

    low = result.get("links", {}).get(
        "Download Low Quality",
        ""
    )

    if not high and not low:
        send_error(chat_id, "No downloadable video was found.")
        return

    session_id = create_session(chat_id)

    if high:
        add_url(session_id, "high", high)

    if low:
        add_url(session_id, "low", low)

    markup = types.InlineKeyboardMarkup()

    if high:
        markup.add(
            types.InlineKeyboardButton(
                "🔥 High Quality",
                callback_data=f"download|{session_id}|high"
            )
        )

    if low:
        markup.add(
            types.InlineKeyboardButton(
                "📱 Low Quality",
                callback_data=f"download|{session_id}|low"
            )
        )

    bot.send_message(
        chat_id,
        "🎞️ Choose the video quality:",
        reply_markup=markup
    )


# =========================
# YOUTUBE
# =========================

def YouTube(message):

    chat_id = message.chat.id
    link = message.text.strip()

    bot.reply_to(
        message,
        "🔎 Searching YouTube...\n"
        "⏳ Please wait."
    )

    headers = {
        "authority": "www.y2mate.com",
        "accept": "*/*",
        "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
        "origin": "https://www.y2mate.com",
        "referer": "https://www.y2mate.com/en858/download-youtube",
        "user-agent": (
            "Mozilla/5.0 (Linux; Android 10; K) "
            "AppleWebKit/537.36 "
            "(KHTML, like Gecko) Chrome/116.0.0.0 "
            "Mobile Safari/537.36"
        ),
        "x-requested-with": "XMLHttpRequest",
    }

    data = {
        "k_query": link,
        "k_page": "Youtube Downloader",
        "hl": "en",
        "q_auto": "0",
    }

    response = safe_request(
        "POST",
        "https://www.y2mate.com/mates/en858/analyzeV2/ajax",
        headers=headers,
        data=data
    )

    if not response:
        send_error(chat_id, "YouTube service is currently unavailable.")
        return

    try:
        result = response.json()
    except Exception as e:
        print(f"[YOUTUBE JSON ERROR] {e}")
        send_error(chat_id, "Could not process this YouTube URL.")
        return

    if result.get("status") != "ok":
        send_error(chat_id, "YouTube could not process this URL.")
        return

    video_id = result.get("vid")

    video_links = (
        result
        .get("links", {})
        .get("mp4", {})
    )

    if not video_links:
        send_error(chat_id, "No video qualities were found.")
        return

    session_id = create_session(chat_id)

    markup = types.InlineKeyboardMarkup()

    for _, video_info in video_links.items():

        size = video_info.get("size", "")
        quality = video_info.get("q", "")
        key = video_info.get("k", "")

        if not quality or not key:
            continue

        convert_headers = {
            "authority": "www.y2mate.com",
            "accept": "*/*",
            "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
            "origin": "https://www.y2mate.com",
            "referer": "https://www.y2mate.com/download-youtube/",
            "user-agent": (
                "Mozilla/5.0 (Linux; Android 10; K) "
                "AppleWebKit/537.36 "
                "(KHTML, like Gecko) Chrome/116.0.0.0 "
                "Mobile Safari/537.36"
            ),
            "x-requested-with": "XMLHttpRequest",
        }

        convert_data = {
            "vid": video_id,
            "k": key,
        }

        convert_response = safe_request(
            "POST",
            "https://www.y2mate.com/mates/convertV2/index",
            headers=convert_headers,
            data=convert_data
        )

        if not convert_response:
            continue

        try:
            download_url = convert_response.json().get(
                "dlink",
                ""
            )
        except Exception:
            download_url = ""

        if not download_url:
            continue

        add_url(
            session_id,
            quality,
            download_url
        )

        text = f"🎬 {quality}"

        if size:
            text += f" • {size}"

        markup.add(
            types.InlineKeyboardButton(
                text,
                callback_data=f"download|{session_id}|{quality}"
            )
        )

    if not markup.keyboard:
        delete_session(session_id)
        send_error(chat_id, "No downloadable qualities are available.")
        return

    bot.send_message(
        chat_id,
        "🎞️ Choose the video quality:",
        reply_markup=markup
    )


# =========================
# TIKTOK
# =========================

def TikTok(message):

    chat_id = message.chat.id
    link = message.text.strip()

    bot.reply_to(
        message,
        "🔎 Searching TikTok...\n"
        "⏳ Please wait."
    )

    headers = {
        "authority": "api.tikmate.app",
        "accept": "*/*",
        "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
        "origin": "https://tikmate.app",
        "referer": "https://tikmate.app/",
        "user-agent": (
            "Mozilla/5.0 (Linux; Android 10; K) "
            "AppleWebKit/537.36 "
            "(KHTML, like Gecko) Chrome/116.0.0.0 "
            "Mobile Safari/537.36"
        ),
    }

    response = safe_request(
        "POST",
        "https://api.tikmate.app/api/lookup",
        headers=headers,
        data={"url": link}
    )

    if not response:
        send_error(chat_id, "TikTok service is currently unavailable.")
        return

    try:
        result = response.json()
    except Exception:
        send_error(chat_id, "Could not process this TikTok URL.")
        return

    if not result.get("success"):
        send_error(chat_id, "TikTok could not process this URL.")
        return

    video_id = result.get("id")
    token = result.get("token")

    if not video_id or not token:
        send_error(chat_id, "No downloadable video was found.")
        return

    video_url = (
        f"https://tikmate.app/download/"
        f"{token}/{video_id}.mp4?hd=1"
    )

    session_id = save_url(
        chat_id,
        "tiktok",
        video_url
    )

    markup = types.InlineKeyboardMarkup()

    markup.add(
        types.InlineKeyboardButton(
            "🎬 Download HD",
            callback_data=f"download|{session_id}|tiktok"
        )
    )

    bot.send_message(
        chat_id,
        "🎞️ Video found:",
        reply_markup=markup
    )


# =========================
# CALLBACK
# =========================

@bot.callback_query_handler(
    func=lambda call: call.data.startswith("download|")
)
def callback_query(call):

    try:

        parts = call.data.split("|", 2)

        if len(parts) != 3:
            bot.answer_callback_query(
                call.id,
                "Invalid download request."
            )
            return

        _, session_id, quality = parts

        video_url = get_url(
            session_id,
            quality
        )

        if not video_url:
            bot.answer_callback_query(
                call.id,
                "This download has expired."
            )
            return

        bot.answer_callback_query(
            call.id,
            "Starting download..."
        )

        chat_id = call.message.chat.id

        status_message = bot.send_message(
            chat_id,
            "⬇️ <b>Downloading...</b>\n"
            "⏳ Please wait."
        )

        filename = (
            f"{uuid.uuid4().hex}.mp4"
        )

        filepath = os.path.join(
            DOWNLOAD_DIR,
            filename
        )

        try:

            response = requests.get(
                video_url,
                stream=True,
                timeout=(15, 120)
            )

            response.raise_for_status()

            total = int(
                response.headers.get(
                    "content-length",
                    0
                )
            )

            downloaded = 0

            with open(filepath, "wb") as file:

                for chunk in response.iter_content(
                    chunk_size=1024 * 64
                ):

                    if not chunk:
                        continue

                    file.write(chunk)
                    downloaded += len(chunk)

            if not os.path.exists(filepath):
                raise Exception("File was not created.")

            bot.delete_message(
                chat_id,
                status_message.message_id
            )

            with open(filepath, "rb") as video:

                bot.send_video(
                    chat_id,
                    video,
                    caption=(
                        "🎬 <b>Downloaded successfully</b>"
                    ),
                    supports_streaming=True
                )

        except Exception as e:

            print(
                f"[DOWNLOAD ERROR] "
                f"{chat_id}: {e}"
            )

            try:
                bot.edit_message_text(
                    "❌ <b>Download failed.</b>\n"
                    "Please try the link again.",
                    chat_id,
                    status_message.message_id
                )
            except Exception:
                send_error(
                    chat_id,
                    "Download failed."
                )

        finally:

            cleanup_file(filepath)
            delete_session(session_id)
            cleanup_old_files()

    except Exception as e:

        print(
            f"[CALLBACK ERROR] {e}"
        )

        try:
            bot.answer_callback_query(
                call.id,
                "Something went wrong."
            )
        except Exception:
            pass


# =========================
# CLEANUP THREAD
# =========================

def cleanup_worker():

    while True:

        try:
            cleanup_old_files()
        except Exception as e:
            print(
                f"[CLEANUP WORKER ERROR] {e}"
            )

        time.sleep(1800)


threading.Thread(
    target=cleanup_worker,
    daemon=True
).start()


# =========================
# BOT START
# =========================

print("🤖 Bot is starting...")

while True:

    try:

        bot.infinity_polling(
            skip_pending=True,
            timeout=30,
            long_polling_timeout=30
        )

    except Exception as e:

        print(
            f"[POLLING ERROR] {e}"
        )

        time.sleep(5)
