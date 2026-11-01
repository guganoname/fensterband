"""Builds the installable web app (index.html, manifest, service worker) at the
repository root from source/src. Run: python3 source/build.py"""
import re, pathlib
root = pathlib.Path(__file__).parent
out = root.parent  # the app is served from the repository root
shell = (root/'src/shell.html').read_text()
js = '\n'.join((root/f'src/{n}.js').read_text() for n in ['engine','demo','app'])
js = js.replace('</script', '<\\/script')
body = shell + '\n<script>\n' + js + '\n</script>\n'
reset = reset = 'html,body{margin:0}:root{padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)}body{font:14px system-ui,sans-serif}img{max-width:100%}[hidden]{display:none!important}'
print(len(body), 'bytes')

# ---------------------------------------------------------------- PWA build
import json, os
pwa = out
fonts = [('Big Shoulders Display', 600, 'big-shoulders-display-latin-600-normal.woff2'), ('Big Shoulders Display', 800, 'big-shoulders-display-latin-800-normal.woff2'),
         ('Overpass', 400, 'overpass-latin-400-normal.woff2'), ('Overpass', 600, 'overpass-latin-600-normal.woff2'), ('Overpass', 700, 'overpass-latin-700-normal.woff2'),
         ('Overpass Mono', 400, 'overpass-mono-latin-400-normal.woff2'), ('Overpass Mono', 600, 'overpass-mono-latin-600-normal.woff2')]
face = ''.join(f'@font-face{{font-family:"{f}";font-style:normal;font-weight:{w};font-display:swap;src:url(fonts/{fn}) format("woff2")}}' for f, w, fn in fonts)
pshell = re.sub(r'<link rel="preconnect"[^>]*>\n', '', shell)
pshell = re.sub(r'<link rel="stylesheet" href="https://fonts.googleapis.com[^>]*>\n', '', pshell)
pshell = pshell.replace('<title>Fensterband</title>\n', '<style>' + face + '</style>\n', 1)
head = ('<!doctype html><html lang="en"><head><meta charset="utf-8">'
  '<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">'
  '<meta name="theme-color" content="#e4e6e2" media="(prefers-color-scheme: light)">'
  '<meta name="theme-color" content="#1d2225" media="(prefers-color-scheme: dark)">'
  '<meta name="apple-mobile-web-app-capable" content="yes"><meta name="mobile-web-app-capable" content="yes">'
  '<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">'
  '<meta name="apple-mobile-web-app-title" content="Fensterband">'
  '<title>Fensterband</title><link rel="manifest" href="manifest.webmanifest">'
  '<link rel="apple-touch-icon" href="icons/apple-touch-icon.png">'
  '<link rel="icon" type="image/png" href="icons/favicon-64.png">'
  f'<style>{reset}</style></head><body>')
boot = "<script>window.__FB_MUXER_URL = 'vendor/mp4-muxer.js';</script>\n"
sw_reg = """<script>
if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
}
</script>"""
(pwa / 'index.html').write_text(head + pshell + boot + '\n<script>\n' + js + '\n</script>\n' + sw_reg + '</body></html>')
manifest = {
  'name': 'Fensterband', 'short_name': 'Fensterband', 'id': './',
  'description': 'Slit-scan camera for train windows: scan live or develop a clip into one continuous panorama.',
  'start_url': './', 'scope': './', 'display': 'standalone', 'orientation': 'any',
  'background_color': '#1d2225', 'theme_color': '#1d2225', 'lang': 'en',
  'icons': [
    {'src': 'icons/icon-192.png', 'sizes': '192x192', 'type': 'image/png'},
    {'src': 'icons/icon-512.png', 'sizes': '512x512', 'type': 'image/png'},
    {'src': 'icons/icon-maskable-512.png', 'sizes': '512x512', 'type': 'image/png', 'purpose': 'maskable'},
    {'src': 'icons/apple-touch-icon.png', 'sizes': '180x180', 'type': 'image/png'},
  ],
}
(pwa / 'manifest.webmanifest').write_text(json.dumps(manifest, indent=2))
assets = ['./', 'index.html', 'manifest.webmanifest', 'vendor/mp4-muxer.js'] + \
  [f'icons/{f}' for f in sorted(os.listdir(pwa / 'icons'))] + [f'fonts/{fn}' for _, _, fn in fonts]
import hashlib
ver = hashlib.sha1((pwa / 'index.html').read_bytes()).hexdigest()[:10]
sw = (root / 'src/sw.js').read_text().replace('__VERSION__', ver).replace('__ASSETS__', json.dumps(assets))
(pwa / 'sw.js').write_text(sw)
print('pwa', ver, len(assets), 'assets')
