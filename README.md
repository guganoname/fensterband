# Fensterband

A slit-scan camera for train windows. It watches the landscape slide past and builds one continuous strip from it, like a document scanner with the train as the scanning motion.

**Open the app:** https://guganoname.github.io/fensterband/

## Install on iPhone or iPad

1. Open the link above in Safari.
2. Share → **Add to Home Screen**.

It then runs full screen with its own icon and works offline, which matters on a train. Camera and location access are asked for on the first scan. Exports open the share sheet: **Save Video** / **Save Image** puts them in Photos.

## What it does

- **Live**: scan from the camera while the train moves. Hold the phone flat against the glass, rear camera facing out.
- **Clip**: open a video you filmed and develop it frame by frame.
- **Demo**: a drawn ride with real distances, to try every control without a train.

Speed is measured from the image in six depth bands, from far hills to the ground next to the track, refined to about a tenth of a pixel. GPS can be logged and used as a calibrated speed source.

Because every frame's slit strip is kept, the strip can be re-developed after scanning:

| Control | Effect |
| --- | --- |
| Depth | which distance keeps its true proportions |
| Other depths | *Smooth*: each band moves at its own speed, nothing repeats. *Strips*: classic slit-scan |
| Stretch | horizontal scale of the result |
| Smoothing | how steady the scanning speed is |
| Steady | vertical shake removal |
| Seam blend | hard cuts or crossfades between frames |
| Trim | drag the end bars in the motion graph |

Exports: one continuous PNG at full resolution (any width), a scan video as MP4 (sweep, scroll or pan; 16:9, 1:1, 4:5, 9:16), and a CSV of every frame's motion.

## Development

The app is plain HTML and JavaScript with no build dependencies beyond Python 3.

```
source/src/engine.js   motion analysis, track, renderer, PNG writer
source/src/demo.js     the drawn demo ride
source/src/app.js      interface, capture, export
source/src/shell.html  markup and styles
source/src/sw.js       offline cache
source/build.py        writes index.html, manifest.webmanifest and sw.js at the repo root
source/tests/          engine tests (node source/tests/engine.test.js)
```

After changing anything in `source/src`, run `python3 source/build.py` and commit the rebuilt files. The installed app picks up the new version the next time it opens with a connection.

## Credits

Typefaces: Big Shoulders Display, Overpass and Overpass Mono, under the SIL Open Font License. MP4 writing: [mp4-muxer](https://github.com/Vanilagy/mp4-muxer) (MIT).
