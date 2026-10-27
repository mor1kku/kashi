# Third-party notices

## mp4-muxer 5.2.2 (bundled)

`vendor/mp4-muxer.min.js` is embedded in `index.html` and is used to write MP4 files.
Source: https://github.com/Vanilagy/mp4-muxer — licensed under the MIT License:

```
MIT License

Copyright (c) 2023 Vanilagy

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Fonts (not bundled)

The web app loads the following typefaces at runtime from Google Fonts (https://fonts.google.com/); they are not
included in this repository. They are distributed by their authors under the SIL Open Font License 1.1:
Noto Sans JP, Noto Serif JP, Dela Gothic One, Zen Kaku Gothic New, Zen Old Mincho, Kaisei Tokumin,
M PLUS Rounded 1c, Mochiy Pop One, DotGothic16, Yuji Syuku, IBM Plex Mono, IBM Plex Sans JP.


## AAC encoder from @mediabunny/aac-encoder 1.62.1 (bundled)

`vendor/aac-encoder.js` is the generated JavaScript/WASM module from the published
`@mediabunny/aac-encoder` package. It contains the AAC-only FFmpeg/libavcodec build
and the Mediabunny C bridge. It is used locally when native AAC encoding is unavailable.

- Package/source: https://github.com/Vanilagy/mediabunny/tree/v1.62.1/packages/aac-encoder
- Exact package: https://registry.npmjs.org/@mediabunny/aac-encoder/-/aac-encoder-1.62.1.tgz
- Package SHA-512: `3fiZYAX95d+TDp2vu0sXMYputLm2+W21fZQMUWTf9awKhsRC/wko9OXj4GLLmGKMRryvI9Ocv9HzhhHVRYWopQ==`
- Mediabunny bridge: Copyright (c) 2026-present, Vanilagy and contributors;
  Mozilla Public License 2.0, included in `vendor/LICENSE.aac-encoder.txt`.
- Bridge source and upstream build instructions are included in `vendor/aac-source/`.
- FFmpeg/libavcodec and libavutil: Copyright FFmpeg developers; LGPL 2.1 or later,
  included in `vendor/LICENSE.FFmpeg-LGPL-2.1.txt`.
  Source: https://github.com/FFmpeg/FFmpeg ; https://ffmpeg.org/download.html#get-sources

The vendored module is unmodified. `build.py` produces `vendor/aac-encoder.browser.js` with a local CommonJS `exports`
shim and replaces `import.meta.url` with `globalThis.location.href` for classic scripts
and Blob workers. The WASM bytes are unchanged. The default build loads this generated file from the same site;
`python3 build.py --standalone` embeds it into the HTML. No encoder files are fetched from a CDN
at runtime. Rebuilding or replacing `vendor/aac-encoder.js` and running `python3 build.py`
relinks the browser app with that module; use the included upstream build instructions
to build a replacement module from source.
