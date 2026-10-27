"""Build the single-file web app (index.html) from src/, app/ and vendor/.
usage: python3 build.py            -> index.html + AAC runtime (served by GitHub Pages)
       python3 build.py --standalone -> self-contained index.html
       python3 build.py --dev      -> also dev/www/jizura.js + dev/www/test.html for the test tools"""
import glob, os, sys
ROOT = os.path.dirname(os.path.abspath(__file__))
os.chdir(ROOT)
read = lambda p: open(p, encoding='utf-8').read()
js = '\n'.join(read(f) for f in sorted(glob.glob('src/*.js')))
mux = '/*! mp4-muxer v5.2.2 | MIT License | (c) 2023 Vanilagy | see THIRD_PARTY_NOTICES.md */\n' + read('vendor/mp4-muxer.min.js')
aac = '(() => { const exports = {};\n' + read('vendor/aac-encoder.js').replace('import.meta.url', 'globalThis.location.href') + '\nglobalThis.JizuraAacModule = exports.default; })();'
open('vendor/aac-encoder.browser.js', 'w', encoding='utf-8').write(aac)
aac_tag = '<script>' + aac + '</script>' if '--standalone' in sys.argv else '<script src="./vendor/aac-encoder.browser.js"></script>'
fonts = ('https://fonts.googleapis.com/css2?family=Dela+Gothic+One&family=Noto+Sans+JP:wght@300;500;700;900&family=Noto+Serif+JP:wght@300;500;700'
         '&family=Zen+Kaku+Gothic+New:wght@900&family=Zen+Old+Mincho:wght@900&family=Kaisei+Tokumin:wght@800&family=M+PLUS+Rounded+1c:wght@800'
         '&family=Mochiy+Pop+One&family=DotGothic16&family=Yuji+Syuku&family=IBM+Plex+Mono:wght@500;600&family=IBM+Plex+Sans+JP:wght@400;500;700&display=swap')
html = f'''<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>JIZURA 字面</title>
<meta name="description" content="歌詞を入れると文字PV（リリックモーション）を自動で組み立てて MP4 に書き出すブラウザアプリ">
<link rel="canonical" href="https://mor1kku.github.io/kashi/">
<meta property="og:type" content="website">
<meta property="og:title" content="JIZURA 字面 — 文字PV自動構成ツール">
<meta property="og:description" content="歌詞を入れると文字PV（リリックモーション）を自動で組み立てて MP4 に書き出すブラウザアプリ">
<meta property="og:url" content="https://mor1kku.github.io/kashi/">
<meta name="twitter:card" content="summary">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="{fonts}">
<style>
{read('app/style.css')}
</style>
</head>
<body>
{read('app/body.html')}
{aac_tag}
<script>
{mux}
</script>
<script>
{js}
</script>
</body>
</html>
'''
open('index.html', 'w', encoding='utf-8').write(html)
print('index.html', len(html), 'bytes')
if '--dev' in sys.argv:
    os.makedirs('dev/www', exist_ok=True)
    open('dev/www/jizura.js', 'w', encoding='utf-8').write(aac + '\n' + js)
    open('dev/www/test.html', 'w', encoding='utf-8').write(read('dev/test.html'))
    print('dev/www ready: cd dev/www && python3 -m http.server 8765')

