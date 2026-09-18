# weddings

A wedding photography portfolio — a static site (plain HTML/CSS/JS, no build
step and no framework) with an in-browser editor that publishes straight to
this repository. Built from the same framework as `My-website`.

## Structure

- `index.html`, `styles.css` — app shell and styling
- `data.json` — all site content: name, typography, pages, photo positions
- `photos/` — published images (created automatically when you publish)
- `js/data.js` — default content, used only if `data.json` can't be fetched
- `js/store.js` — draft state, password gate, IndexedDB staging for photos
- `js/images.js` — resizing and thumbnail generation
- `js/github.js` — GitHub API client (atomic multi-file commits)
- `js/layout.js` — free-form drag/resize with alignment guides
- `js/crop.js` — crop modal
- `js/app.js` — router, rendering, edit mode

## One-time setup

1. **Enable GitHub Pages.** In this repository's Settings → Pages, set
   Source to "Deploy from a branch", branch `main`, folder `/ (root)`. The
   site will then be live at `https://<owner>.github.io/weddings/`.
2. **Connect the editor to GitHub** so it can publish. Create a
   [fine-grained personal access token](https://github.com/settings/personal-access-tokens/new)
   with **Repository access: only `weddings`** and
   **Permissions → Repository → Contents: Read and write**. Open the site,
   turn on edit mode (see below), click **Connect**, check the repository
   field says the right `owner/weddings`, and paste the token.

A custom domain can be added later the same way `My-website` has one: add a
`CNAME` file at the repo root with the domain, and point its DNS at GitHub
Pages.

## Running locally

```sh
python3 -m http.server 8000
```

Then open `http://localhost:8000/`.

## Editing

**Edit site** is hidden by default, so visitors see a plain portfolio with no
sign that the site is editable. To show the button on a device, load the site
once with `?edit` on the address:

```
https://<owner>.github.io/weddings/?edit
```

The button then stays on that device until you load `?edit=off`. The marker is
taken straight back out of the address bar, so it can't be carried into a
bookmark you share or read over your shoulder. Each device is separate — the
same as the password and the GitHub token.

This is tidiness, not a lock. The site is public and anyone can read this code
and find `?edit`. What actually protects the site is the **token**, which lives
only in your browser: without it nothing can be published, button or no.

Click **Edit site** (bottom right). The first time you'll set a password;
after that it asks for it. In edit mode you can:

- **Add photos** — select many at once; each is resized and thumbnailed. New
  photos are laid out in two columns at the end of the page, each going to
  whichever column is currently shortest so tall photos don't leave gaps.
  Nothing already on the page moves.
- **Add text** — drops a paragraph on the page, one column wide, below
  everything else, with the caret already in it.
- **Arrange** — reflows everything on the page, photos and text together, into
  two columns. Handy for starting from a tidy grid; it replaces the current
  positions, so it asks first. It flows things in reading order — down the
  page, then across — rather than the order they were added.

### Moving photos around

- **Drag** a photo anywhere. Faint blue guides appear when an edge or centre
  lines up with another photo.
- **Drag near the top or bottom of the window** and the page scrolls, so a
  photo can be moved right across a page several screens tall.
- **Arrow keys** nudge the selected photo (the one with the blue outline) by a
  hair; hold **Shift** for larger steps. Easier than dragging for fine
  alignment.
- **Resize** from the square handle at the bottom-right corner.

### Everything else in edit mode

- **Replace / Crop / Adjust / Link / Front / Remove** from the buttons above a
  photo on hover
- Edit any text directly on the page (titles, captions, body copy)
- **Style** — set Helvetica weight and size for each kind of text, and upload a custom cursor
- **Pages** — rename, reorder, add and delete pages and sections

### Reordering pages

**Pages** lists every page in menu order, with a **↑** and **↓** beside each
one. The arrows move a page one step at a time and the menu updates
immediately; the order in the panel is the order in the menu. A section's
children move within their own section, so a sub-page can't accidentally jump
out into the top-level menu. The arrows grey out at the ends of a list.

## Rotating and desaturating a photo

**Adjust** on a photo opens a panel with a live preview:

- **Rotate left / right** turns the photo in quarter steps. The page reflows
  around the new shape.
- **Saturation** runs from 0% (black and white) to 200%. 100% is the photo as
  shot.
- **Reset** puts both back to default.

Neither is written into the image file — they're stored as two numbers and
applied when the photo is drawn, so changing them is instant and can always be
undone. **Crop** is the one place that has to cut from what you actually see,
so cropping a rotated photo bakes the rotation into the new file.

## Text on a page

**Add text** puts a paragraph on the canvas. It moves, resizes, snaps to the
guides and takes arrow-key nudges exactly like a photo does.

- **Drag it by the dotted grip bar** along its top edge.
- **Type straight into it.** Enter starts a new paragraph, and line breaks are kept.
- **Resize** from the corner handle. Only the width is yours to set; the height
  follows the words.
- **Align** cycles left → centre → right.
- **Remove** deletes it.

## Photo links and hover labels

**Link** on a photo opens a panel with two independent settings:

- **Hover label** — fades in over the photo when the pointer is over it.
  Desktop only.
- **Link** — pick a page on this site from the dropdown, or type any web
  address.

## Logo instead of the name

**Style → Heading → Upload logo** replaces the text at the top with your own
wordmark. Use a PNG with a transparent background.

## Custom cursor

**Style → Cursor → Upload image** takes a small PNG with a transparent
background and uses it as the pointer across the whole site. Desktop only.

## Phones

**Style → On phones** chooses between two ways of showing a free-form page on
a screen far narrower than the one it was composed on:

- **Same as desktop, shrunk** (the default) keeps every photo exactly where you
  put it, scaled down as one piece.
- **Stacked grid** drops the arrangement and runs the photos one after another
  at a readable size, two across, in reading order.

## How saving works

Edits save to your browser immediately as you work. To make them public the
site commits to this repository via the GitHub API, using the token from
**Connect** (see one-time setup above).

After that, saving is automatic: about 2.5 seconds after you stop making
changes, `data.json` and any new photos are committed in a single commit. The
status text at bottom-left shows `Saving…` then `Saved`. GitHub Pages
redeploys within roughly a minute, which is when visitors see the change.
**Save now** forces an immediate save, and **Done** saves before exiting.

The token is stored only in your browser. Anyone with your unlocked device
could use it to write to this one repository — revoke it from GitHub settings
if that ever matters. The edit password is a convenience gate, not real
security; it doesn't protect anything from someone using dev tools.

If you add photos and close the tab before publishing, they're kept in
IndexedDB and restored next time you open the site in edit mode.

## About image quality and speed

Each upload produces two files: a display version capped at 2560px (quality
0.85) and an 800px thumbnail. Grids load thumbnails and lazy-load them as you
scroll. The full display version loads only when a photo is opened.

Your original files are never uploaded or altered; keep them backed up
separately.
