# Matchboard artwork → app fixtures

The matchboard in the PNG generator draws on `server/fixtures/matchboard/background.png`
(the MATCHBOARD-BROADCAST artwork without texts, flags and highlights) using
`server/fixtures/matchboard/layout.json` (every text and team row with its position).

To rebuild both from a new version of the PDF exported from Illustrator (needs Python 3 with
`pymupdf`, `pikepdf`):

```sh
python3 extract.py MATCHBOARD-BROADCAST.pdf raw.json        # texts and rows (13 pt rows, 3-letter codes = teams)
python3 layout.py raw.json ../../server/fixtures/matchboard/layout.json
python3 background.py MATCHBOARD-BROADCAST.pdf raw.json clean.pdf bg.png   # writes clean-red.pdf
python3 strip_paths.py clean-red.pdf raw.json clean-final.pdf
python3 -c "import pymupdf; pymupdf.open('clean-final.pdf')[0].get_pixmap(alpha=True).save('../../server/fixtures/matchboard/background.png')"
```

`background.py` lists the highlight shadings (`/Sh…`) and wave forms (`/Fm…`) of this artwork by name;
check them again if the layout of the PDF changes.
