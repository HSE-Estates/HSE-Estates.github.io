# Site branding

Two files control the logo and organisation name that appear in the PDF header.
Both are optional — with neither, the PDF simply has no header.

## Why these files exist

A logo chosen in **Settings** is stored in that one browser, on that one device.
That is fine for you on your laptop, and useless the moment you open the app on
your phone or publish it to GitHub Pages — the logo is not there, because
localStorage does not travel with the site.

These files live in the repository, so the logo is part of the site. Set it once
and it appears on every device and for everyone who opens the published app.

## logo.txt

One line: a base64 **data URL** of your logo.

```
data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAA...
```

A bare base64 string with no `data:` prefix also works — it is assumed to be a
PNG. Whitespace and line breaks are stripped, so a wrapped file is fine.

### Getting that string without touching a command line

1. Open the app.
2. **Settings → Sheet branding → Choose logo**, and pick your image file.
3. Click **Save for the whole site**. A `logo.txt` downloads.
4. Drop it into this folder, replacing the empty one, and push.

That is the whole job. The app has already downscaled the image to 520 px and
converted it, so the file stays small.

### Or, from a terminal

```bash
printf 'data:image/png;base64,' > branding/logo.txt && base64 -w0 my-logo.png >> branding/logo.txt
```

On Windows PowerShell:

```powershell
'data:image/png;base64,' + [Convert]::ToBase64String([IO.File]::ReadAllBytes('my-logo.png')) | Set-Content -NoNewline branding/logo.txt
```

## brand.json

```json
{ "orgName": "Your organisation" }
```

Shown in bold in the PDF header above the project name. Leave it empty to show
the project name alone.

## Which wins

Site branding from these files is the **default**. A logo chosen in Settings
overrides it on that device only, so an individual surveyor can brand their own
exports without changing the site. **Settings → Sheet branding → Use site logo**
clears the local override.

## Use a logo you are entitled to use

The app ships no organisation's mark. Putting a logo here asserts that you have
the right to publish documents under it — that is your call to make, not the
app's. This matters more than usual because a floor plan with an organisation's
logo on it reads as a document issued by that organisation.
