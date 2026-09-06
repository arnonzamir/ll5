---
name: media
description: Media-handling procedures — images, camera-reel [Photo] events, voice notes and audio (on-box transcription), videos, PDF and other documents (fetch, verify, extract), saving chat images, and delivering generated images (rasterize, upload, public links). Invoke on any [image/voice_note/audio/video/document attached] tag or [Photo] system event, and before delivering a generated image. CLAUDE.md keeps the standing rules; this skill is the how-to.
---

# Media Handling

WhatsApp and chat messages can include media attachments. System messages indicate the type:
- `[image attached: /uploads/...]` — photo or screenshot
- `[voice_note attached: /uploads/... (15s)]` — WhatsApp voice message with duration
- `[audio attached: /uploads/...]` — audio file
- `[video attached: /uploads/... (30s)]` — video with duration
- `[document attached: /uploads/...]` — PDF, doc, etc.

A failing media tool (`inspect_image`, the transcriber, a fetch) is a first-class event — Hard Rule 14: triage your own call first, then escalate with `push_to_user`; never answer as if you saw or heard something you couldn't.

## Images
Use `inspect_image` to view the image, then act:
- **With text**: respond to the question/instruction about the image
- **Without text**: infer intent from context (recent conversation, time, location). Examples:
  - Receipt photo → capture expense or note the purchase
  - Screenshot → extract and act on the relevant info
  - Photo of something broken → create a fix action
  - Photo of a whiteboard/document → summarize the content
  - If unclear, capture to inbox with the image URL for later

## Photos the user takes (`[Photo]` system events)
The phone pushes photos the user takes (the camera reel) to the gateway; each
lands as a `[Photo]` system message with `media_id`, `url`, time, and sometimes
location, and is stored in media (`source:camera`). The user shoots a lot — to
**remember/be reminded** of things — so be **proactive but selective**:
- **Don't inspect every photo.** First judge from the metadata + context (time,
  location, what calendar event / place / person it lines up with) whether it's
  likely *reminder-worthy* — a whiteboard, a document/receipt, a parking spot, a
  product, a sign, a place. Most photos (selfies, scenery, kids) need nothing.
- **For the promising ones**, `inspect_image` the `url`, then act on what it's
  for: capture an action/tickler ("remember where I parked — level 3, near the
  elevators"), note a `note_observation`/journal entry, expand a KB fact, and
  **`link_media`** it to the matching event/person/place/project (match the
  photo's time to the day's calendar + your location history).
- **Speak up only when it genuinely helps** — "Saw you photographed the
  whiteboard during the LMS sync — want me to turn the action items into tasks?"
  Otherwise stay silent: index + link, no chat. Never narrate every shot.
- Bursts: if several photos arrive together, handle them as one batch.

## Voice Notes & Audio
When you see a voice note or audio attachment, **transcribe it** — the box has
faster-whisper (CPU, on-box, private; auto-detects Hebrew/English):
```
curl -s -H "Authorization: Bearer $(cat ~/.ll5/token)" \
     https://gateway.noninoni.click/uploads/wa_vn_... -o /tmp/vn.ogg
python3 /workspace/ll5-run/scripts/transcribe.py /tmp/vn.ogg
```
The first run downloads the model (~once, cached on the persistent volume), so it
may take longer; later runs are fast. Then:
1. If transcription succeeds, treat the text as a message and act on it normally — and it's usually worth noting the gist in a journal/observation.
2. If it fails (exits non-zero / empty), note who sent it, in which conversation, and push: "Voice note from [sender] in [group] — couldn't transcribe, please review."
3. Capture to inbox if it might be actionable.

## Videos
You **cannot view** videos directly. Same approach as audio:
1. Note the metadata (sender, group, duration/filename)
2. Push to user if it's from an important conversation
3. Capture to inbox for review

## Documents (PDFs and other files)
You **can** read documents — never punt a file back to the user "to download and
re-upload". Get the file onto disk, then extract. The same `[document attached:
/uploads/...]` chat tag arrives for **chat uploads** too, not just WhatsApp —
any non-image attachment lands as that tag. The PDF flow below is the canonical
one; other file types are handled at the end of this section.

1. **Get the bytes to a local file.**
   - **Attached in chat** (`[document attached: /uploads/...]`) — curl it down with
     your token, exactly like a voice note:
     ```
     curl -s -H "Authorization: Bearer $(cat ~/.ll5/token)" \
          https://gateway.noninoni.click/uploads/<file> -o /tmp/doc.pdf
     ```
   - **Behind a browser login** (a portal you're signed into — payslips, bank
     statements, invoices; see the `vault-login` skill for the login itself): the
     file is same-origin to the page, so fetch it **inside the authenticated
     browser** and bring the bytes back through the MCP — a plain curl from here
     has no session cookies. (The Chrome PDF viewer's `contentDocument` is empty
     to JS — that's the *viewer*, not the file; fetch the PDF URL itself, the real
     file has a text layer.)

     **Transport — chunked hex, never one giant base64 Write.** A single 30k+ char
     base64 string round-tripped through one `Write` is fragile: it can drop a byte
     (corrupting the decode), and the long Write can stall long enough that the
     portal session times out before the next file. Instead, fetch once into the
     page, then pull it out in small **hex** chunks (hex has no padding and is
     length-checkable: 2 chars per byte, exactly). `browser_evaluate` step 1 — cache
     and report size:
     ```js
     async () => {
       const r = await fetch("<pdf url>", { credentials: "include" });
       window.__pdf = new Uint8Array(await r.arrayBuffer());
       return window.__pdf.length;                 // e.g. 58321
     }
     ```
     Then loop `browser_evaluate` over 8KB slices, appending each to a file:
     ```js
     (off) => Array.from(window.__pdf.slice(off, off + 8192))
                   .map(b => b.toString(16).padStart(2, "0")).join("")
     ```
     Reassemble + **verify** before trusting it:
     ```
     python3 -c "import sys; open('/tmp/doc.pdf','wb').write(bytes.fromhex(open('/tmp/doc.hex').read().strip()))"
     test "$(stat -c%s /tmp/doc.pdf)" = "<size from step 1>" || echo "SHORT — refetch"
     head -c5 /tmp/doc.pdf | grep -q '%PDF' || echo "NOT A PDF — refetch"
     ```
     If the byte count doesn't match or it's not a `%PDF`, the transport dropped
     data — refetch, don't parse garbage.

2. **Extract.**
   - **Text / numbers** (payslips, statements — anything where digits must be exact):
     `pdftotext -layout /tmp/doc.pdf -`. `-layout` preserves columns so tables stay
     aligned. This is deterministic — always prefer it over vision for figures. If it
     comes back empty, the file is corrupt or text-less — see below; don't guess.
   - **No text comes out** (a scan / image-only PDF): rasterize and read it with
     vision — `pdftoppm -png -r 150 /tmp/doc.pdf /tmp/page` then `Read` each
     `/tmp/page-*.png` (or `Read /tmp/doc.pdf` directly).

3. **Then act** — build the comparison/summary, capture findings, reply. For a
   **multi-file job** (e.g. several months of payslips): loop fetch+verify+extract
   per file, `narrate` progress as each lands ("3/6 parsed"), and if the portal needs
   a fresh OTP/login to continue, **`push_to_user` the ask** rather than waiting
   silently (CLAUDE.md, "long jobs report as they go"). Parse server-side and report
   the result — don't make the user download anything.

### Non-PDF documents
These arrive via the same `[document attached: /uploads/...]` tag. Curl the file
down with your token exactly as above, then read it by type:

- **Plain text / CSV / Markdown / JSON** (`.txt` `.csv` `.md` `.json`): no
  conversion — just `Read` the file (or `cat`) directly.
- **Word** (`.docx` `.odt` `.rtf`): `pandoc` is on-box.
  ```
  pandoc -t plain /tmp/doc.docx          # clean text
  pandoc -t markdown /tmp/doc.docx       # preserve headings/tables/lists
  ```
- **Excel** (`.xlsx`): read with Python openpyxl (installed on-box). For figures
  that must be exact, prefer this over vision:
  ```
  python3 -c "
  import openpyxl, csv, sys
  wb = openpyxl.load_workbook('/tmp/sheet.xlsx', data_only=True)
  w = csv.writer(sys.stdout)
  for ws in wb.worksheets:
      print(f'--- {ws.title} ---')
      for row in ws.iter_rows(values_only=True):
          w.writerow(['' if c is None else c for c in row])
  "
  ```
  `data_only=True` returns computed values, not formulas.
- **Not parsed** — `pptx`, legacy `.doc` / `.xls`: there's no on-box reader. Tell
  the user plainly and offer to read it if they export to **PDF** (then use the PDF
  flow above).

## Saving Images from Chat
When the user pastes an image in the CLI and wants it stored, use `save_image` to upload it to the gateway, then `link_media` to connect it to the relevant entity.

## Delivering generated images (charts, maps, route overlays)
Chat clients — the Android app especially — **cannot render SVG**, and the gateway only accepts raster uploads (JPG/PNG/GIF/WebP). So **never upload an SVG**. When you generate a vector image, rasterize it to PNG first, then upload the PNG:
```
rsvg-convert route.svg -o route.png    # librsvg2-bin, installed in the image
# (or imagemagick: `convert route.svg route.png`)
```
Then deliver the PNG. Two URL options:
- **In-chat only** (private, needs the LL5 token to load — fine for showing inside the app): `save_image`, or POST to `/chat/upload`, returns a `/uploads/...` URL.
- **Publicly shareable** (opens in any browser, forwardable): POST with `?public=1` — the gateway stores it under an unguessable name and returns a `public_url` you can paste anywhere:
  ```
  curl -s -H "Authorization: Bearer $(cat ~/.ll5/token)" \
       -F "file=@out.png" "https://gateway.noninoni.click/chat/upload?public=1"
  # → {"url":"/public/<rand>.png","public_url":"https://gateway.noninoni.click/public/<rand>.png", ...}
  ```
  `public_url` lives on the user's **own** server (`gateway.noninoni.click`, not a third party) — it's just un-gated: unguessable, but anyone handed the link can open it. **Privacy rule:** don't *unilaterally* put sensitive content (personal screenshots, private docs, anything identifying) behind a public link. But this is the user's own infrastructure, so **if the user has asked for or approved it, you may put whatever they want there** — the caution is about you deciding to expose something on your own, not a hard ban. When unsure whether something's sensitive, use the private `/uploads` link or ask.

For a **map with a real route**, prefer a clickable maps link (a Google Maps directions URL with the key waypoints) over a hand-drawn overlay — the overlay only shows the route shape on a blank canvas, not actual map tiles.
