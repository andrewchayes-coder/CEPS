# Referral confirmation fonts

Bundled under the SIL Open Font License. See `OFL.txt` and
`OFL-NotoSansSC.txt`. Production builds copy this directory into `dist/assets/fonts`.

- Noto Sans Regular / Bold, Arabic Regular, and Gurmukhi Regular:
  https://github.com/notofonts/noto-fonts/tree/main/hinted/ttf
- Noto Sans SC:
  https://github.com/notofonts/noto-cjk/blob/main/Sans/Variable/TTF/Subset/NotoSansSC-VF.ttf
  Instantiated at `wght=400` using fontTools; no variable-font runtime needed.

PDFs embed subsets, not complete font files. Arabic right-to-left layout is
outside this fix's scope; unsupported code points render as `?`.
