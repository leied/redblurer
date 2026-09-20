# RedBlurer

A program I use, as a BYOD student in school, to blur stuff when browsing social media in case anything that could raise the admins' eyebrows would show up on my feed, despite my 10+ hours of doomscrollong did not show any signs of this happening, but better safe than sorry. It is a Chrome extension that automatically blurs images and videos on specified websites, with options to reveal them on hover or keep them blurred for privacy.

You would enjoy tweaking it. Built by students, for students. 

> **Heads-up**
>
> This project is heavily vibe-coded (LLM-assisted). It may contain bugs, edge cases, and unpolished code paths. I would really appreciate community fixes, reviews, and refactors.
> 
> Due to academics, I haven't coded for a while and kinda forgot everything. After changing my mindset of not grinding that much, I decided to pick up coding again, which is something I always wanted to do. 

## Roadmap so far
- [x] fix bug where it is not working with certain websites
- [ ] handle closed shadow roots, which extensions cannot see into
- [ ] blur text as well as media, for DMs and comment threads
- [ ] brainstorm what can I do next

## Features

- Automatic blur on `<img>`, `<video>`, and background-image elements, including ones
  the page adds later.
- Works inside iframes and open shadow roots, which is where a lot of feeds actually
  put their media.
- Hover-to-reveal, a "keep it unblurred once I've looked" mode, and a "never unblur on
  hover" mode for when you really can't risk it.
- Pauses video and strips autoplay while blurred, even when the site tries to restart
  playback itself.
- Blur everywhere, or only on the domains you list. Subdomains are included.
- Adjustable blur strength.
- Export/import configuration to keep settings in sync across browsers.
- Light and dark themes, and it never loads anything over the network.

Small images are left alone on purpose: below 48px, it is a favicon or an avatar or a
tracking pixel, and blurring those wrecks the page without hiding anything worth hiding.
Add `data-redblurer-skip` to any element you want it to ignore.

## Getting Started

1. Clone the repo:

   ```bash
   git clone https://github.com/lzccr/RedBlurer.git
   cd RedBlurer
   ```

2. Load the extension:

   - Open `chrome://extensions/`.
   - Enable **Developer mode**.
   - Click **Load unpacked** and select the `src` directory.

3. Pin the extension (optional) so the popup is a click away.

## Usage

- The big switch at the top turns blurring on and off everywhere.
- "Blur on every site" is on by default. Turn it off to use the domain list instead,
  one domain per line. An empty list then means nothing gets blurred.
- "Keep media unblurred" leaves anything you have revealed visible for the rest of the
  page's life.
- "Never unblur on hover" keeps everything hidden no matter where the cursor goes.
- Export/Import saves and restores a JSON snapshot of your settings. Files exported by
  version 1 still import.

Your settings carry over from version 1 automatically. Nothing needs re-entering.

## Development

No build step. The `src` directory is the extension, exactly as Chrome loads it.

```
src/shared/    pure logic, shared by every context and covered by tests
src/content/   the script and styles that do the blurring
src/popup/     the settings UI
src/background.js   install, migration, and the toolbar badge
```

Tests run on Node's built-in runner:

```bash
npm test
```

The logic tests need nothing installed. The tests that drive a real DOM need jsdom, and
skip themselves with a note if it is missing:

```bash
npm install && npm test
```

## Contributing

Sorry if the code is not perfect due to it being mostly vibe coded, but I would really appreciate any contributions, whether it's fixing bugs, improving code quality, or adding new features. Feel free to open issues or submit pull requests.

## License

Licensed under the [MIT License](LICENSE). See the license file for details.
