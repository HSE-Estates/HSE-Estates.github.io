# Putting it online — step by step

Two separate jobs. **Part 1 (GitHub) is the one you need.** Part 2 (Hugging
Face) is optional and you can ignore it for now.

Neither costs anything.

---

# Part 1 — Put the app on the internet with GitHub Pages

**Why:** your phone will not let a web page use the camera or the motion sensors
unless the page is on `https`. GitHub Pages gives you `https` free. That is the
whole reason we are doing this.

**Time:** about ten minutes the first time.

## Step 1 — Make a GitHub account

Go to <https://github.com> and sign up. Free account is fine.

## Step 2 — Make an empty repository

A repository — "repo" — is just a folder that lives on GitHub.

1. Click the **+** at the top right → **New repository**.
2. **Repository name:** `room-scanner`
3. Choose **Public**.
   *It has to be public on a free account. This is safe: there are no passwords
   or keys in the code. Your API key stays in your browser and is never uploaded.*
4. Do **not** tick "Add a README file". Leave everything else alone.
5. Click **Create repository**.

You now see a page with some commands on it. Ignore them; use the ones below.

## Step 3 — Send the files up

Open a terminal in the `hse-room-scanner` folder and run these, one at a time.

Set up the folder as a repo:

```bash
git init -b main
```

Add every file:

```bash
git add .
```

Save them with a message:

```bash
git commit -m "Room Scanner"
```

Connect to GitHub — **replace YOURNAME with your GitHub username**:

```bash
git remote add origin https://github.com/YOURNAME/room-scanner.git
```

Send it:

```bash
git push -u origin main
```

The first push asks you to sign in to GitHub. A browser window opens — approve
it there.

**Checkpoint:** refresh the GitHub page. You should now see `index.html`, `css`,
`js` and the rest.

## Step 4 — Turn on Pages

1. In your repository, click **Settings** (top right, with the cog).
2. In the left menu, click **Pages**.
3. Under **Source**, choose **Deploy from a branch**.
4. Set the branch to **main** and the folder to **/ (root)**.
5. Click **Save**.

Wait one to two minutes. Refresh the page and a green box appears with your
address:

```
https://YOURNAME.github.io/room-scanner/
```

## Step 5 — Open it on your phone

Type that address into your phone's browser. Then:

- Tap **Start scan**.
- The phone asks for the **camera** — allow it.
- On an iPhone it also asks for **motion and orientation** — allow that too. If
  you say no, scanning cannot measure anything.

**Checkpoint:** you see the camera with a crosshair in the middle and a small
plan box in the corner. That is it working.

Add it to your home screen (Share → Add to Home Screen) and it opens like an app.

## Step 6 — When you change something later

Three commands, every time:

```bash
git add .
```

```bash
git commit -m "what I changed"
```

```bash
git push
```

The live site updates about a minute later.

## Putting your logo on it

The logo you pick in **Settings** is saved in that one browser, on that one
computer. That is why it does not show up on your phone. To make it part of the
site so it appears everywhere:

1. On your computer, open the app → **Settings → Sheet branding → Choose logo**.
2. Click **Save for whole site**. A file called `logo.txt` downloads.
3. Move that file into the `branding` folder, replacing the empty `logo.txt`.
4. Open `branding/brand.json` and put your organisation's name between the
   quotes: `"orgName": "Your organisation"`.
5. Push it up with the three commands above.

Now the logo is on the PDF on every device, for everyone.

## If something goes wrong

| What you see | What it means |
|---|---|
| Page is blank, or "404" | Pages is still building. Wait two minutes and refresh. |
| Camera never asks permission | You are on `http` not `https`, or opened the file directly. Use the `github.io` address. |
| iPhone: plan does not follow the phone | Motion access was refused. Safari → Settings → Motion & Orientation Access, then reload. |
| `git push` says "rejected" | Someone changed the repo online. Run `git pull --rebase` then push again. |
| Logo missing on the phone | You saved it in Settings but did not do the `logo.txt` steps above. |

---

# Part 2 — Hugging Face (optional, skip it for now)

**What it does:** adds a "Detect items" button that looks at one photo and
guesses the furniture, so you tap less.

**What it does NOT do:** it does not make measurements more accurate. All the
measuring stays on your phone.

**Honest advice: do not bother yet.** Tapping a bed takes two seconds. Waking a
sleeping free server takes about a minute. Get the scanning working first.

If you still want it:

## Step 1 — Account

Sign up at <https://huggingface.co>.

## Step 2 — Make a Space

A "Space" is a small free computer that runs your code.

1. Go to <https://huggingface.co/new-space>.
2. **Space name:** `room-scanner-assist`
3. **License:** MIT
4. **Space SDK:** choose **Gradio**.
5. **Hardware:** **CPU basic — FREE**.
6. **Public**.
7. Click **Create Space**.

## Step 3 — Add the two files

On the Space page, click **Files** → **+ Add file** → **Upload files**.

Upload these two, from the `server/hf-space` folder of the project:

- `app.py`
- `requirements.txt`

Click **Commit changes to main**.

## Step 4 — Wait

Top right shows **Building**. It takes five to ten minutes the first time — it is
downloading the vision models. When it says **Running**, it is ready.

## Step 5 — Copy the address

Your Space address looks like:

```
https://YOURNAME-room-scanner-assist.hf.space
```

Note the dash between your name and the space name, and that it ends `.hf.space`
— not `huggingface.co`.

## Step 6 — Paste it into the app

App → **Settings → Optional heavy processing** → paste the address → **Save**.

Now during a scan, on the **Furniture** step, a **Detect items** button appears.

## Things that will confuse you

- **The first click takes about a minute.** Free Spaces go to sleep after a
  couple of days unused, and waking up is slow. The app tells you this. Later
  clicks take a few seconds.
- **It is public.** Anyone with the address can use your Space. There is nothing
  private in it, but be aware.
- **It only knows common objects.** Beds, sofas, chairs, toilets, sinks,
  fridges. It has never heard of a wardrobe or a shower tray, so it will miss
  them. Tap those yourself.
- **Everything it suggests is marked unconfirmed** with a red dashed box, and
  the checks panel lists it, until you accept it. That is deliberate — a guess
  should never sit on your plan looking like a measurement.

---

# What about the AI (Claude / Gemini)?

Different thing again, and nothing to install.

1. Get a key from <https://console.anthropic.com> (Claude) or
   <https://aistudio.google.com> (Gemini).
2. App → **Settings → Optional AI** → pick the provider → paste the key → tick
   the consent box → **Save**.
3. Click **Test connection**. It should say it classified a test room.

Then the right-hand panel gets three buttons: label the room, review the plan for
mistakes, and **Style for an audience**.

This costs whatever your provider charges — pennies per use. It sends room
dimensions and item names only, never a photograph. It can never change a
measurement.
