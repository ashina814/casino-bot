# -*- coding: utf-8 -*-
"""星約の賭場 — 二通貨経済 財務モデル（骨格）ビルダー"""
from openpyxl import Workbook
from openpyxl.styles import Font, PatternFill, Alignment, Border, Side
from openpyxl.utils import get_column_letter
from openpyxl.formatting.rule import ColorScaleRule, CellIsRule

FONT = "Meiryo"
BLUE = "0000FF"      # 入力（手で変える値）
GREEN = "008000"     # 他シート参照
BLACK = "000000"     # 計算式
YELLOW = "FFFF00"    # 要差し替え（Gill依頼 or 未定）
HDR_FILL = "1F3864"  # 濃紺ヘッダ
SEC_FILL = "D9E1F2"  # 薄青セクション
NOTE = "808080"

thin = Side(style="thin", color="BFBFBF")
border = Border(left=thin, right=thin, top=thin, bottom=thin)

GIL = '#,##0;(#,##0);"-"'
PCT = '0.0%'

def f(bold=False, color=BLACK, size=10, italic=False):
    return Font(name=FONT, bold=bold, color=color, size=size, italic=italic)

def title(ws, cell, text):
    ws[cell] = text
    ws[cell].font = f(bold=True, size=14, color="1F3864")

def header_row(ws, row, headers, start_col=1):
    for i, h in enumerate(headers):
        c = ws.cell(row=row, column=start_col + i, value=h)
        c.font = f(bold=True, color="FFFFFF")
        c.fill = PatternFill("solid", fgColor=HDR_FILL)
        c.alignment = Alignment(horizontal="center", vertical="center", wrap_text=True)
        c.border = border

def section(ws, row, text, span=6):
    c = ws.cell(row=row, column=1, value=text)
    c.font = f(bold=True, color="1F3864")
    c.fill = PatternFill("solid", fgColor=SEC_FILL)
    for col in range(2, span + 1):
        ws.cell(row=row, column=col).fill = PatternFill("solid", fgColor=SEC_FILL)

wb = Workbook()

# ════════════════════════════════════════════════════════════
# Sheet 1: 説明
# ════════════════════════════════════════════════════════════
ws = wb.active
ws.title = "説明"
ws.sheet_view.showGridLines = False
title(ws, "B2", "星約の賭場 — 二通貨経済 財務モデル（骨格 v0.1）")
lines = [
    ("B4", "目的：第一通貨 Gil と 第二通貨 エテル(◈) の流入/シンクが横断で釣り合うかを見て、", False),
    ("B5", "　　　給与・ショップ価格・為替レートを“設計・最適化”するための盤面。", False),
    ("B7", "■ 使い方", True),
    ("B8", "　1. 「前提・レバー」シートの青字・黄色セルを埋める/弄る（人数・価格・レート等）。", False),
    ("B9", "　2. 「Gil経済」「エテル経済」が月次の mint/sink を自動計算。", False),
    ("B10", "　3. 「見通し」が12ヶ月先の供給推移、「ダッシュボード」が要点を表示。", False),
    ("B12", "■ 色の意味", True),
    ("B13", "　青字 = 手で入れる入力値（シナリオで変える）", False),
    ("B14", "　黒字 = 計算式　／　緑字 = 他シート参照", False),
    ("B15", "　黄色セル = 要差し替え（Gill側に依頼 or 未定の値）", False),
    ("B17", "■ データの出どころ（役割分担）", True),
    ("B18", "　エテル経済の実績 → うちのBotがスナップショット抽出", False),
    ("B19", "　Gil経済の実績   → Gill側Botがスナップショット提供（要依頼）", False),
    ("B20", "　値段/レートの決定 → 俺ら（経理課）＝このモデルで判断", False),
    ("B22", "■ 主要レバー（このモデルで我々が動かす）", True),
    ("B23", "　① 為替レート（Gil:エテル）　② 還光率（現状20%）", False),
    ("B24", "　③ ショップ価格（Gilシンク）　④ 福分け・ハウスエッジ等カジノ内パラメータ", False),
    ("B26", "作成: 経理課 / 2026-06　｜　給与表 出典: サーバー「給与一覧」2026-05-28", False),
]
for cell, text, bold in lines:
    ws[cell] = text
    ws[cell].font = f(bold=bold, color="1F3864" if bold else BLACK)
# legend swatches
ws["B13"].font = f(color=BLUE)
ws["B14"].font = f(color=BLACK)
ws["D14"] = ""
ws["B15"].fill = PatternFill("solid", fgColor=YELLOW)
ws.column_dimensions["A"].width = 2
ws.column_dimensions["B"].width = 70

# ════════════════════════════════════════════════════════════
# Sheet 2: 前提・レバー
# ════════════════════════════════════════════════════════════
ws = wb.create_sheet("前提・レバー")
ws.sheet_view.showGridLines = False
title(ws, "A1", "前提・レバー（入力シート）")
ws["A2"] = "青字=入力 / 黄色=要差し替え。月額 = 単価 × 人数(件数/量)。"
ws["A2"].font = f(italic=True, color=NOTE)

COLS = ["区分", "項目", "単価/給与", "人数/件数/量", "月額", "備考・データ源"]
widths = [14, 22, 14, 14, 16, 34]
for i, w in enumerate(widths):
    ws.column_dimensions[get_column_letter(i + 1)].width = w

ranges = {}  # section_name -> (first_row, last_row) of 月額(E)

def add_table(ws, start_row, sec_name, rows, headcount_default_yellow=False):
    """rows: list of (区分, 項目, 単価, 数量, 備考, unit_is_input, qty_yellow, price_yellow)"""
    header_row(ws, start_row, COLS)
    r = start_row + 1
    first = r
    for (kubun, item, price, qty, memo, price_yellow, qty_yellow) in rows:
        ws.cell(row=r, column=1, value=kubun).font = f()
        ws.cell(row=r, column=2, value=item).font = f()
        pc = ws.cell(row=r, column=3, value=price)
        pc.font = f(color=BLUE); pc.number_format = GIL
        if price_yellow: pc.fill = PatternFill("solid", fgColor=YELLOW)
        qc = ws.cell(row=r, column=4, value=qty)
        qc.font = f(color=BLUE); qc.number_format = GIL
        if qty_yellow: qc.fill = PatternFill("solid", fgColor=YELLOW)
        mc = ws.cell(row=r, column=5, value=f"=C{r}*D{r}")
        mc.font = f(); mc.number_format = GIL
        nc = ws.cell(row=r, column=6, value=memo)
        nc.font = f(color=NOTE, size=9)
        for col in range(1, 7):
            ws.cell(row=r, column=col).border = border
        r += 1
    last = r - 1
    ranges[sec_name] = (first, last)
    # subtotal
    sc = ws.cell(row=r, column=2, value=f"小計（{sec_name}）")
    sc.font = f(bold=True)
    tc = ws.cell(row=r, column=5, value=f"=SUM(E{first}:E{last})")
    tc.font = f(bold=True); tc.number_format = GIL
    tc.fill = PatternFill("solid", fgColor=SEC_FILL)
    return r + 2  # next start row (gap)

row = 4
section(ws, row, "Gil 流入①：給与（階級ロール・1人1つ／2週ごとに評価で昇降＝平均分布）"); row += 1
row = add_table(ws, row, "給与_階級", [
    ("階級", "星約者", 50000, 10, "現行維持。人数=2週変動の平均", False, True),
    ("階級", "巡星者", 30000, 30, "★主層。人数=2週変動の平均", False, True),
    ("階級", "堕星者", 20000, 8,  "現行維持。人数=平均", False, True),
    ("階級", "背律者", 0,     3,  "罰則(最下位)0。降格先=自動mint減", False, True),
])

section(ws, row, "Gil 流入②：給与（役職ロール・重複可・固定分のみ）"); row += 1
row = add_table(ws, row, "給与_役職", [
    ("役職", "モーセの十戒", 150000, 1, "固定", False, True),
    ("役職", "天銀官", 70000, 1, "固定", False, True),
    ("優遇", "星導官", 0, 6, "完全歩合(基本給0)。理想6人=統括1+従者3-5+見習0-2・各上限12万", False, True),
    ("優遇", "審星官・特級", 90000, 1, "顔役優遇:80000→90000 ＋評価歩合", False, True),
    ("優遇", "審星官・Ⅰ級", 60000, 1, "顔役優遇:50000→60000", False, True),
    ("優遇", "審星官・Ⅱ級", 40000, 2, "顔役優遇:30000→40000", False, True),
    ("優遇", "審星官・Ⅲ級", 25000, 2, "顔役優遇:20000→25000", False, True),
    ("優遇", "審星官・見習い", 15000, 3, "顔役優遇:10000→15000", False, True),
    ("役職", "星祭官", 50000, 1, "固定", False, True),
    ("役職", "印章官", 50000, 1, "＋個人依頼＋鯖スタンプ×10000", False, True),
    ("役職", "星商官", 50000, 1, "固定", False, True),
    ("役職", "幻戯官", 50000, 1, "固定", False, True),
    ("役職", "失星官", 30000, 1, "固定", False, True),
    ("役職", "贖罪官", 30000, 1, "固定", False, True),
    ("役職", "星賭官", 20000, 1, "＋勝ち×500(変動別枠)", False, True),
    ("役職", "18禁", 0, 0, "完全依頼制(変動)", True, True),
])

section(ws, row, "Gil 流入③：給与（運営・Secret／含めると経済は健全側）"); row += 1
row = add_table(ws, row, "給与_運営", [
    ("運営", "原初星", 0, 1, "Secret＝要Gill", True, True),
    ("運営", "七星", 0, 1, "Secret＝要Gill", True, True),
    ("運営", "叛逆者", 0, 1, "Secret＝要Gill", True, True),
    ("運営", "執行官", 0, 1, "Secret＝要Gill", True, True),
])

section(ws, row, "Gil 流入④：給与以外（Gill運用・額/頻度は要Gill or 我々が最適化）"); row += 1
row = add_table(ws, row, "Gil流入_その他", [
    ("流入", "日記報酬", 5000, 20, "刻:30日5万/100日10万/200日15万/300日20万/365日30万+ロール", True, True),
    ("流入", "招待報酬", 10000, 5, "刻:5人5万/10人10万/+10万per10人/100人100万+ロール+Secret", True, True),
    ("流入", "ランク報酬", 15000, 6, "10Lvごと逓増マイルストーン", True, True),
    ("流入", "サバブ達成", 40000, 3, "刻:3〜5万×回数(仮4万)", True, True),
    ("流入", "VC在席報酬", 100, 2000, "刻:裁量で任せ→100Gil/h。会話VC限定", True, True),
    ("変動", "審星官 評価歩合", 1500, 40, "見習500〜特級2500×枚数。実作業=ノーキャップ＋監視", True, True),
    ("変動", "星導官 歩合(面接+個別)", 3000, 10, "完全歩合・全収入。面接3000×回＋個別対応1000×件・上限12万", True, True),
    ("変動", "星賭官 勝ち歩合", 500, 100, "500×勝ち。○月キャップ50k＋最低ベット閾値(農耕防止)", True, True),
    ("不定期", "イベント・公式配布", 200000, 5, "仮上限=月100万に増額(ステージ等のsink原資)", True, True),
])

section(ws, row, "Gil シンク：ショップ（手動運用・価格は我々が決める）"); row += 1
row = add_table(ws, row, "Gilシンク_ショップ", [
    # A. 反復課金（小〜中）
    ("反復", "名前変更(2回目以降)", 100000, 2, "初回無料/2回目以降10万。ぽんぽん防止", False, True),
    ("反復", "カラーネーム(期間色)", 20000, 6, "反復", False, True),
    ("反復", "鯖スタンプ追加", 15000, 8, "反復", False, True),
    ("反復", "一時ブースト(XP/福分け)", 25000, 6, "期間制", False, True),
    # B. サブスク（継続課金）
    ("サブスク", "荒野通行証", 80000, 6, "月サブスク・格差ゲート。数量=購読者数", False, True),
    ("サブスク", "監獄通行証", 80000, 4, "月サブスク。数量=購読者数", False, True),
    ("サブスク", "18禁コンテンツロール", 5000, 10, "刻案:普及狙いでサブスク5千/月(買切なら5万)", False, True),
    ("サブスク", "Sub垢 維持費", 50000, 2, "刻決定:Sub垢の月維持費5万", False, True),
    # C. 高額・ステータス
    ("高額", "ステージ利用者証", 300000, 1, "刻:最低30万。大型sink→イベント上限の原資", False, True),
    ("高額", "Sub垢 導入", 300000, 2, "刻決定:導入30万(維持費は別行)", False, True),
    ("高額", "シクレ宿(価格仮)", 50000, 2, "要・刻確認(中身次第)。仮5万/回", False, True),
    # D. 鯨シンク
    ("鯨", "限定カスタムロール", 2000000, 2, "刻:非グラデ前提で〇。グラデ可なら上位価格", False, True),
    # E. 部屋立て代金（従量・GILL徴収）
    ("部屋代金", "宿代(2人個室)", 8000, 15, "刻:問題無し", False, True),
    ("部屋代金", "ゲーム部屋(GO後)", 8000, 12, "刻:プレオープン無料/GO後8千", False, True),
    ("部屋代金", "ゲーム部屋サブスク", 30000, 3, "刻案:ヘビーユーザー向け立て放題", False, True),
])

# ── 為替レバー（単独セル群） ──
section(ws, row, "為替レバー（二通貨を繋ぐパイプ）"); row += 1
ex_start = row
ex = [
    ("為替レート R（1エテル=何Gil）", 10, GIL, BLUE, "我々が決定。Gil÷エテルの交換比", False),
    ("還光率 h（エテル→Gil 出口の目減り）", 0.20, PCT, BLUE, "現状20%。半分JP/半分救済", False),
    ("Gil→エテル 両替量 / 月（Gil）", 0, GIL, BLUE, "接続後に実績。Gilは消滅", True),
    ("エテル→Gil 換金量 / 月（エテル）", 0, GIL, BLUE, "接続後に実績", True),
]
ws.cell(row=row, column=1, value="レバー").font = f(bold=True)
ws.cell(row=row, column=2, value="項目").font = f(bold=True)
ws.cell(row=row, column=3, value="値").font = f(bold=True)
row += 1
ex_cells = {}
for name, val, fmt, color, memo, yellow in ex:
    ws.cell(row=row, column=2, value=name).font = f()
    vc = ws.cell(row=row, column=3, value=val)
    vc.font = f(color=color); vc.number_format = fmt
    if yellow: vc.fill = PatternFill("solid", fgColor=YELLOW)
    ws.cell(row=row, column=6, value=memo).font = f(color=NOTE, size=9)
    ex_cells[name] = f"C{row}"
    row += 1
row += 1

# ── カジノ行動前提 ──
section(ws, row, "カジノ行動前提（エテル経済の駆動・launch後データ待ち＝仮値）"); row += 1
ws.cell(row=row, column=1, value="前提").font = f(bold=True)
ws.cell(row=row, column=2, value="項目").font = f(bold=True)
ws.cell(row=row, column=3, value="値").font = f(bold=True)
row += 1
casino = [
    ("アクティブ人数", 30, '#,##0', "エテルを動かす人数(仮)"),
    ("1人あたり 月間プレイ回数", 200, '#,##0', "仮"),
    ("平均ベット額（エテル）", 500, GIL, "仮"),
    ("実効ハウスエッジ", 0.05, PCT, "4〜5%±2%。economy.ts"),
    ("福分け 1人1日 平均（エテル）", 200, GIL, "300/225/150/100の加重(仮)"),
    ("月日数", 30, '#,##0', "月→日換算"),
]
casino_cells = {}
for name, val, fmt, memo in casino:
    ws.cell(row=row, column=2, value=name).font = f()
    vc = ws.cell(row=row, column=3, value=val)
    vc.font = f(color=BLUE); vc.number_format = fmt
    ws.cell(row=row, column=6, value=memo).font = f(color=NOTE, size=9)
    casino_cells[name] = f"C{row}"
    row += 1
row += 1

# ── カジノ内パラメータ（参考・固定） ──
section(ws, row, "カジノ内パラメータ（参考・ハウス吸収の行先など）"); row += 1
ws.cell(row=row, column=1, value="参考").font = f(bold=True)
ws.cell(row=row, column=2, value="項目").font = f(bold=True)
ws.cell(row=row, column=3, value="値").font = f(bold=True)
row += 1
params = [
    ("ハウス吸収→消滅 率", 0.50, PCT, "economy.distributeHouseEarnings"),
    ("ハウス吸収→救済 率", 0.30, PCT, "同上"),
    ("ハウス吸収→JP 率", 0.20, PCT, "同上"),
    ("初期残高（エテル）", 3000, GIL, "db.ts"),
    ("残高上限（エテル）", 300000, GIL, "db.ts"),
]
param_cells = {}
for name, val, fmt, memo in params:
    ws.cell(row=row, column=2, value=name).font = f()
    vc = ws.cell(row=row, column=3, value=val)
    vc.font = f(color=BLUE); vc.number_format = fmt
    ws.cell(row=row, column=6, value=memo).font = f(color=NOTE, size=9)
    param_cells[name] = f"C{row}"
    row += 1

P = "前提・レバー"

def rng(name):
    a, b = ranges[name]
    return f"'{P}'!$E${a}:$E${b}"

def exc(name): return f"'{P}'!${ex_cells[name][0]}${ex_cells[name][1:]}"
def cas(name): return f"'{P}'!${casino_cells[name][0]}${casino_cells[name][1:]}"
def par(name): return f"'{P}'!${param_cells[name][0]}${param_cells[name][1:]}"

# ════════════════════════════════════════════════════════════
# Sheet 3: Gil経済
# ════════════════════════════════════════════════════════════
ws = wb.create_sheet("Gil経済")
ws.sheet_view.showGridLines = False
ws.column_dimensions["A"].width = 36
ws.column_dimensions["B"].width = 18
ws.column_dimensions["C"].width = 40
title(ws, "A1", "Gil経済（月次フロー）")

def line(ws, r, label, formula, memo="", bold=False, fill=None, green=False, fmt=GIL):
    lc = ws.cell(row=r, column=1, value=label); lc.font = f(bold=bold)
    vc = ws.cell(row=r, column=2, value=formula)
    vc.font = f(bold=bold, color=GREEN if green else BLACK); vc.number_format = fmt
    if fill:
        lc.fill = PatternFill("solid", fgColor=fill); vc.fill = PatternFill("solid", fgColor=fill)
    if memo:
        ws.cell(row=r, column=3, value=memo).font = f(color=NOTE, size=9)
    return r + 1

r = 3
ws.cell(row=r, column=1, value="◆ Gil 流入（mint / 月）").font = f(bold=True, color="1F3864"); r += 1
r = line(ws, r, "給与・階級", f"=SUM({rng('給与_階級')})", "Σ 人数×給与", green=True)
r = line(ws, r, "給与・役職", f"=SUM({rng('給与_役職')})", "重複可・固定分", green=True)
r = line(ws, r, "給与・運営(Secret)", f"=SUM({rng('給与_運営')})", "要Gill", green=True)
r = line(ws, r, "日記/招待/ブースト/VC", f"=SUM({rng('Gil流入_その他')})", "Gill運用", green=True)
mint_row = r
r = line(ws, r, "Gil mint 合計 / 月", f"=SUM(B4:B7)", "", bold=True, fill=SEC_FILL)
r += 1

ws.cell(row=r, column=1, value="◆ Gil シンク（sink / 月）").font = f(bold=True, color="1F3864"); r += 1
shop_row = r
r = line(ws, r, "ショップ購入（手動）", f"=SUM({rng('Gilシンク_ショップ')})", "価格=我々", green=True)
casino_in_row = r
r = line(ws, r, "カジノ両替 Gil→エテル（消滅）", f"={exc('Gil→エテル 両替量 / 月（Gil）')}", "Gilは消滅", green=True)
sink_row = r
r = line(ws, r, "Gil sink 合計 / 月", f"=B{shop_row}+B{casino_in_row}", "", bold=True, fill=SEC_FILL)
r += 1

ws.cell(row=r, column=1, value="◆ カジノからの戻り（mint側）").font = f(bold=True, color="1F3864"); r += 1
ret_row = r
r = line(ws, r, "エテル→Gil 換金で戻るGil", f"={exc('エテル→Gil 換金量 / 月（エテル）')}*(1-{exc('還光率 h（エテル→Gil 出口の目減り）')})/{exc('為替レート R（1エテル=何Gil）')}", "(1-還光)×量÷レート", green=True)
r += 1

ws.cell(row=r, column=1, value="◆ 収支").font = f(bold=True, color="1F3864"); r += 1
net_row = r
r = line(ws, r, "Gil 純増 / 月", f"=B{mint_row}+B{ret_row}-B{sink_row}", "mint+戻り−sink", bold=True, fill="FFF2CC")
absorb_row = r
r = line(ws, r, "カジノ純吸収（Gil）", f"=B{casino_in_row}-B{ret_row}", "両替流入−戻り", bold=True)
r = line(ws, r, "カジノ吸収率（対Gil mint）", f"=IF(B{mint_row}=0,0,B{absorb_row}/B{mint_row})", "カジノがGil mintの何%を吸うか", bold=True, fmt=PCT)

gil_mint_cell = f"'Gil経済'!$B${mint_row}"
gil_net_cell = f"'Gil経済'!$B${net_row}"
gil_absorb_cell = f"'Gil経済'!$B${absorb_row}"

# ════════════════════════════════════════════════════════════
# Sheet 4: エテル経済
# ════════════════════════════════════════════════════════════
ws = wb.create_sheet("エテル経済")
ws.sheet_view.showGridLines = False
ws.column_dimensions["A"].width = 36
ws.column_dimensions["B"].width = 18
ws.column_dimensions["C"].width = 42
title(ws, "A1", "エテル経済（月次フロー・◈）")

r = 3
# 中間計算
ws.cell(row=r, column=1, value="◆ 中間計算").font = f(bold=True, color="1F3864"); r += 1
wager_row = r
r = line(ws, r, "月間 総ベット額（エテル）", f"={cas('アクティブ人数')}*{cas('1人あたり 月間プレイ回数')}*{cas('平均ベット額（エテル）')}", "人数×回数×平均ベット", green=True)
absorbed_row = r
r = line(ws, r, "ハウス吸収額（エテル）", f"=B{wager_row}*{cas('実効ハウスエッジ')}", "総ベット×エッジ", green=True)
fukubun_row = r
r = line(ws, r, "福分け mint（エテル）", f"={cas('アクティブ人数')}*{cas('福分け 1人1日 平均（エテル）')}*{cas('月日数')}", "人数×日額×日数", green=True)
r += 1

ws.cell(row=r, column=1, value="◆ エテル mint（発行 / 月）").font = f(bold=True, color="1F3864"); r += 1
r = line(ws, r, "福分け（daily）", f"=B{fukubun_row}", "")
ex_mint_row = r
r = line(ws, r, "Gil→エテル 両替で発行", f"={exc('Gil→エテル 両替量 / 月（Gil）')}/{exc('為替レート R（1エテル=何Gil）')}", "両替Gil÷レート", green=True)
e_mint_row = r
r = line(ws, r, "エテル mint 合計 / 月", f"=B{r-2}+B{ex_mint_row}", "", bold=True, fill=SEC_FILL)
r += 1

ws.cell(row=r, column=1, value="◆ エテル シンク（消滅 / 月）").font = f(bold=True, color="1F3864"); r += 1
burn_row = r
r = line(ws, r, "ハウス吸収の50%消滅", f"=B{absorbed_row}*{par('ハウス吸収→消滅 率')}", "残り50%はプールへ(供給内)", green=True)
ex_burn_row = r
r = line(ws, r, "エテル→Gil 換金で消滅", f"={exc('エテル→Gil 換金量 / 月（エテル）')}*(1-{exc('還光率 h（エテル→Gil 出口の目減り）')})", "(1-還光)分がGil化し消滅", green=True)
e_sink_row = r
r = line(ws, r, "エテル sink 合計 / 月", f"=B{burn_row}+B{ex_burn_row}", "景品/累進奉納は別途", bold=True, fill=SEC_FILL)
r += 1

ws.cell(row=r, column=1, value="◆ 収支").font = f(bold=True, color="1F3864"); r += 1
e_net_row = r
r = line(ws, r, "エテル 純増 / 月", f"=B{e_mint_row}-B{e_sink_row}", "mint−sink", bold=True, fill="FFF2CC")
pool_row = r
r = line(ws, r, "プール流入（救済30%+JP20%）", f"=B{absorbed_row}*({par('ハウス吸収→救済 率')}+{par('ハウス吸収→JP 率')})", "供給内で循環", green=True)

e_mint_cell = f"'エテル経済'!$B${e_mint_row}"
e_net_cell = f"'エテル経済'!$B${e_net_row}"

# ════════════════════════════════════════════════════════════
# Sheet 5: 見通し（12ヶ月）
# ════════════════════════════════════════════════════════════
ws = wb.create_sheet("見通し")
ws.sheet_view.showGridLines = False
title(ws, "A1", "見通し（12ヶ月・月次純増を一定と仮定した投影）")
ws["A2"] = "開始供給は青字で入力。月次純増は各経済シートから参照（簡易：一定）。"
ws["A2"].font = f(italic=True, color=NOTE)

ws.column_dimensions["A"].width = 22
for c in range(2, 16):
    ws.column_dimensions[get_column_letter(c)].width = 13

# 開始供給 入力
ws["A4"] = "Gil 開始供給"; ws["A4"].font = f(bold=True)
ws["B4"] = 5000000; ws["B4"].font = f(color=BLUE); ws["B4"].number_format = GIL
ws["C4"] = "← 要Gill（現Gil総供給）"; ws["C4"].font = f(color=NOTE, size=9); ws["C4"].fill = PatternFill("solid", fgColor=YELLOW)
ws["A5"] = "エテル 開始供給"; ws["A5"].font = f(bold=True)
ws["B5"] = "='エテル経済'!B5*0"  # placeholder, replaced below
ws["B5"] = 90000; ws["B5"].font = f(color=BLUE); ws["B5"].number_format = GIL
ws["C5"] = "← Bot監視の現エテル総供給"; ws["C5"].font = f(color=NOTE, size=9)

hr = 7
header_row(ws, hr, ["月"] + [f"M{i}" for i in range(0, 13)])
# Gil row
ws.cell(row=hr+1, column=1, value="Gil 供給").font = f(bold=True)
ws.cell(row=hr+2, column=1, value="エテル 供給").font = f(bold=True)
ws.cell(row=hr+3, column=1, value="均衡指標").font = f(bold=True)
for i in range(0, 13):
    col = 2 + i
    L = get_column_letter(col)
    gc = ws.cell(row=hr+1, column=col)
    ec = ws.cell(row=hr+2, column=col)
    if i == 0:
        gc.value = "=$B$4"; ec.value = "=$B$5"
    else:
        prevL = get_column_letter(col-1)
        gc.value = f"={prevL}{hr+1}+{gil_net_cell}"
        ec.value = f"={prevL}{hr+2}+{e_net_cell}"
    gc.font = f(color=BLACK); gc.number_format = GIL
    ec.font = f(color=BLACK); ec.number_format = GIL
    # 均衡: Gil純増の符号
ws.cell(row=hr+3, column=2, value=f'=IF({gil_net_cell}>0,"Gil増（吸収不足/インフレ寄り）",IF({gil_net_cell}<0,"Gil減（吸いすぎ/デフレ寄り）","均衡"))').font = f(italic=True)

# ════════════════════════════════════════════════════════════
# Sheet 6: ダッシュボード
# ════════════════════════════════════════════════════════════
ws = wb.create_sheet("ダッシュボード")
ws.sheet_view.showGridLines = False
ws.column_dimensions["A"].width = 32
ws.column_dimensions["B"].width = 20
ws.column_dimensions["C"].width = 36
title(ws, "A1", "ダッシュボード（要点）")

kpi = [
    ("Gil mint 合計 / 月", f"={gil_mint_cell}", GIL, "サーバーが月に刷るGil"),
    ("Gil 純増 / 月", f"={gil_net_cell}", GIL, "＞0=インフレ寄り / ＜0=デフレ寄り"),
    ("カジノ純吸収（Gil）", f"={gil_absorb_cell}", GIL, "カジノが吸うGil"),
    ("カジノ吸収率（対Gil mint）", f"=IF({gil_mint_cell}=0,0,{gil_absorb_cell}/{gil_mint_cell})", PCT, "目標値を別途決める"),
    ("エテル mint 合計 / 月", f"={e_mint_cell}", GIL, "カジノ内発行"),
    ("エテル 純増 / 月", f"={e_net_cell}", GIL, "＞0=エテル増"),
    ("為替レート R", f"={exc('為替レート R（1エテル=何Gil）')}", GIL, "1エテル=?Gil（レバー）"),
    ("還光率 h", f"={exc('還光率 h（エテル→Gil 出口の目減り）')}", PCT, "レバー"),
]
r = 3
header_row(ws, r, ["指標", "値", "意味"]); r += 1
for name, formula, fmt, memo in kpi:
    ws.cell(row=r, column=1, value=name).font = f(bold=True)
    vc = ws.cell(row=r, column=2, value=formula); vc.font = f(color=GREEN); vc.number_format = fmt
    ws.cell(row=r, column=3, value=memo).font = f(color=NOTE, size=9)
    for col in range(1, 4):
        ws.cell(row=r, column=col).border = border
    r += 1

r += 1
ws.cell(row=r, column=1, value="■ 次に確定したいレバー").font = f(bold=True, color="1F3864"); r += 1
for t in ["為替レート R（接続後の本丸）", "ショップ各価格（Gilシンクの主力）",
          "VC在席レート（Gill側だが我々が最適化提案）", "カジノ吸収率の目標%（経済設計の北極星）"]:
    ws.cell(row=r, column=1, value="・" + t).font = f(); r += 1

# ════════════════════════════════════════════════════════════
# Sheet 7: 取得時間（time-to-earn）— 設計の主盤面
# ════════════════════════════════════════════════════════════
ws = wb.create_sheet("取得時間")
ws.sheet_view.showGridLines = False
title(ws, "A1", "取得時間（time-to-earn）— 各財が“月収の何ヶ月分”か")
ws["A2"] = "値 = 価格 ÷ 月収。色: 緑=近い / 赤=遠い。価格・給与は前提シートと連動。数量△に依存しない設計盤面。"
ws["A2"].font = f(italic=True, color=NOTE)
ws.column_dimensions["A"].width = 24
for c in "BCDEFG":
    ws.column_dimensions[c].width = 15

ka = ranges["給与_階級"][0]      # 星約者=ka, 巡星者=ka+1
yk = ranges["給与_役職"][0]      # 0モーセ1天銀2星導3特級4Ⅰ級…8星祭9印章
seiyaku = f"'{P}'!$C${ka}"
junsei  = f"'{P}'!$C${ka+1}"
tengin  = f"'{P}'!$C${yk+1}"     # 天銀官70k
seisai  = f"'{P}'!$C${yk+8}"     # 星祭官(標準役職50k)
insho   = f"'{P}'!$C${yk+9}"     # 印章官50k
shin1   = f"'{P}'!$C${yk+4}"     # 審星官Ⅰ級(顔役)

# ヘッダ＋月収行
hr = 4
header_row(ws, hr, ["財 ＼ プロファイル", "価格(Gil)", "巡星者(主層)", "星約者(無役)", "星約者＋役職", "星約者＋顔役", "役職重ね持ち(富裕)"])
ws.cell(row=hr+1, column=1, value="月収(Gil) →").font = f(bold=True, italic=True)
inc = {3: f"={junsei}", 4: f"={seiyaku}", 5: f"={seiyaku}+{seisai}",
       6: f"={seiyaku}+{shin1}", 7: f"={seiyaku}+{tengin}+{seisai}+{insho}"}
for col, formula in inc.items():
    c = ws.cell(row=hr+1, column=col, value=formula)
    c.font = f(color=GREEN, bold=True); c.number_format = GIL
    c.fill = PatternFill("solid", fgColor="E2EFDA")

# 財の行（ショップ価格と連動）
sfirst = ranges["Gilシンク_ショップ"][0]
n_items = ranges["Gilシンク_ショップ"][1] - sfirst + 1
start = hr + 2
for i in range(n_items):
    r = start + i
    pr = sfirst + i
    nc = ws.cell(row=r, column=1, value=f"='{P}'!$B${pr}"); nc.font = f(color=GREEN)
    pc = ws.cell(row=r, column=2, value=f"='{P}'!$C${pr}"); pc.font = f(color=GREEN); pc.number_format = GIL
    for col in range(3, 8):
        L = get_column_letter(col)
        cc = ws.cell(row=r, column=col, value=f"=IF({L}${hr+1}=0,0,$B{r}/{L}${hr+1})")
        cc.font = f(); cc.number_format = '0.0"ヶ月"'
    for col in range(1, 8):
        ws.cell(row=r, column=col).border = border
last = start + n_items - 1

# カラースケール（0ヶ月=緑 / 6=黄 / 12+=赤）
rule = ColorScaleRule(
    start_type="num", start_value=0, start_color="63BE7B",
    mid_type="num", mid_value=6, mid_color="FFEB84",
    end_type="num", end_value=12, end_color="F8696B",
)
ws.conditional_formatting.add(f"C{start}:G{last}", rule)

# 目標バンドの目安
gr = last + 2
ws.cell(row=gr, column=1, value="■ 目標バンドの目安（主層基準）").font = f(bold=True, color="1F3864")
bands = [
    "消耗品（反復）: 〜1ヶ月  … 気軽に何度も買える",
    "通行証・中位: 1〜3ヶ月  … 貯めれば手が届く",
    "中ステータス: 3〜6ヶ月  … 目標になる",
    "最上位ステータス: 6〜12ヶ月  … 憧れ・長期目標",
    "12ヶ月超: 原則 価格↓ or 給与↑ を検討",
    "※例外=鯨の蓄財シンク（限定カスタムロール等）: 意図的にバンド外。カジノ大勝ち/蓄財/イベント報酬を吸う最上位プレステージ。主層の取得時間で測らない",
    "※サブスク=通行証（継続課金）: 表の値は『月収の何倍/期の維持費』と読む。>1=収入だけでは維持不可＝富裕層向けの格差ゲート（意図的）",
    "設計原則: 格差はそこそこ許容（給与スプレッド維持・高額財は高く・過度な平準化はしない）",
]
for i, t in enumerate(bands):
    ws.cell(row=gr+1+i, column=1, value="・" + t).font = f(size=9, color=NOTE)

# ════════════════════════════════════════════════════════════
# Sheet 8: 収入設計（非役職の稼ぎ口・floor design）
# ════════════════════════════════════════════════════════════
ws = wb.create_sheet("収入設計")
ws.sheet_view.showGridLines = False
title(ws, "A1", "収入設計 — 非役職メンバーの稼ぎ口（floor design）")
ws["A2"] = "日記/招待/ランク報酬/VC は“役職なし”の主稼ぎ。役職持ちと採算をとり、主層に満足できる progression を。青字=設計入力。"
ws["A2"].font = f(italic=True, color=NOTE)
ws.column_dimensions["A"].width = 22
for c in "BCDE":
    ws.column_dimensions[c].width = 18

profiles = ["非役職カジュアル", "非役職アクティブ", "役職持ち(1職)", "役職持ち(重ね)"]
sources = [
    ("階級ベース",       [30000, 30000, 50000, 50000]),
    ("日記報酬",         [8000, 15000, 10000, 10000]),
    ("招待報酬",         [0, 20000, 10000, 10000]),
    ("ランク報酬(月割)", [3000, 8000, 5000, 5000]),
    ("VC在席",           [5000, 10000, 8000, 10000]),
    ("役職給",           [0, 0, 50000, 170000]),
    ("歩合",             [0, 0, 0, 30000]),
]
hr = 4
header_row(ws, hr, ["収入源"] + profiles)
r = hr + 1
first = r
for name, vals in sources:
    ws.cell(row=r, column=1, value=name).font = f()
    for i, v in enumerate(vals):
        c = ws.cell(row=r, column=2 + i, value=v); c.font = f(color=BLUE); c.number_format = GIL
    for col in range(1, 6):
        ws.cell(row=r, column=col).border = border
    r += 1
last = r - 1
ws.cell(row=r, column=1, value="月収 合計").font = f(bold=True)
for i in range(4):
    L = get_column_letter(2 + i)
    c = ws.cell(row=r, column=2 + i, value=f"=SUM({L}{first}:{L}{last})")
    c.font = f(bold=True); c.number_format = GIL
    c.fill = PatternFill("solid", fgColor=SEC_FILL)
total_row = r
r += 1
ws.cell(row=r, column=1, value="対 主層ベース(30k) 倍率").font = f(italic=True)
for i in range(4):
    L = get_column_letter(2 + i)
    c = ws.cell(row=r, column=2 + i, value=f"={L}{total_row}/30000")
    c.font = f(italic=True); c.number_format = '0.0"x"'
r += 2
ws.cell(row=r, column=1, value="■ 設計方針").font = f(bold=True, color="1F3864"); r += 1
for t in ["非役職カジュアル: 素ベース×1.5前後（軽く触るだけでも上乗せ感）",
          "非役職アクティブ: 素ベース×2.5〜3（日記+招待+昇格で“頑張れば報われる”床）",
          "役職持ちとは更に差 → 格差はそこそこ維持（やりがい＋上を目指す動機）",
          "全faucetは消滅シンク前提＝派手に出してOK。Gil mint総額は前提シートで監視"]:
    ws.cell(row=r, column=1, value="・" + t).font = f(size=9, color=NOTE); r += 1

# ════════════════════════════════════════════════════════════
# Sheet 9: 定員プラン（各役職を何人雇えるか）
# ════════════════════════════════════════════════════════════
ws = wb.create_sheet("定員プラン")
ws.sheet_view.showGridLines = False
title(ws, "A1", "定員プラン — 各役職を何人雇えるか（予算 vs シンク）")
ws["A2"] = "青字=入力。役職の定員を変えると残予算が動く。月給/歩合/身分給は前提シートと連動。"
ws["A2"].font = f(italic=True, color=NOTE)
ws.column_dimensions["A"].width = 26
for c in "BCD":
    ws.column_dimensions[c].width = 15

ka_sub = ranges["給与_階級"][1] + 1   # 階級小計行
otf = ranges["Gil流入_その他"][0]      # その他先頭(日記)
yk = ranges["給与_役職"][0]            # 役職先頭(モーセ)

# 予算ブロック
ws["A4"] = "給与予算 / 月（シンク連動）"; ws["A4"].font = f(bold=True)
b4 = ws["B4"]; b4.value = 2500000; b4.font = f(color=BLUE); b4.number_format = GIL
b4.fill = PatternFill("solid", fgColor=YELLOW)
ws["C4"] = "堅い1.3M〜現状2.5M〜カジノ後4M"; ws["C4"].font = f(size=9, color=NOTE)
ws["A5"] = "− 身分給（会員数で決まる固定費）"; ws["A5"].font = f()
b5 = ws["B5"]; b5.value = f"='{P}'!E{ka_sub}"; b5.font = f(color=GREEN); b5.number_format = GIL
ws["A6"] = "＝ 役職に回せる予算"; ws["A6"].font = f(bold=True)
b6 = ws["B6"]; b6.value = "=B4-B5"; b6.font = f(bold=True); b6.number_format = GIL
b6.fill = PatternFill("solid", fgColor=SEC_FILL)

# 役職テーブル
roles = ["モーセの十戒", "天銀官", "星導官", "審星官・特級", "審星官・Ⅰ級", "審星官・Ⅱ級",
         "審星官・Ⅲ級", "審星官・見習い", "星祭官", "印章官", "星商官", "幻戯官",
         "失星官", "贖罪官", "星賭官", "18禁"]
defcount = [1, 1, 6, 1, 1, 2, 2, 3, 1, 1, 1, 1, 1, 1, 1, 0]
hr = 8
header_row(ws, hr, ["役職", "月給/人", "定員(計画)", "月額"])
r = hr + 1; first = r
for i, role in enumerate(roles):
    ws.cell(row=r, column=1, value=role).font = f()
    pc = ws.cell(row=r, column=2, value=f"='{P}'!C{yk + i}"); pc.font = f(color=GREEN); pc.number_format = GIL
    dc = ws.cell(row=r, column=3, value=defcount[i]); dc.font = f(color=BLUE); dc.number_format = '#,##0'
    mc = ws.cell(row=r, column=4, value=f"=B{r}*C{r}"); mc.font = f(); mc.number_format = GIL
    for col in range(1, 5):
        ws.cell(row=r, column=col).border = border
    r += 1
last = r - 1
ws.cell(row=r, column=1, value="※星導官=完全歩合(基本給0)。定員を増やしても固定費0・働いた分のみ上限12万/人").font = f(size=9, color=NOTE)
r += 1
ws.cell(row=r, column=1, value="役職コスト 計").font = f(bold=True)
cc = ws.cell(row=r, column=4, value=f"=SUM(D{first}:D{last})"); cc.font = f(bold=True); cc.number_format = GIL
cost_row = r; r += 1
ws.cell(row=r, column=1, value="＋歩合（評価+星導+星賭）").font = f()
bc = ws.cell(row=r, column=4, value=f"='{P}'!E{otf+5}+'{P}'!E{otf+6}+'{P}'!E{otf+7}"); bc.font = f(color=GREEN); bc.number_format = GIL
buai_row = r; r += 1
ws.cell(row=r, column=1, value="残予算（役職予算−コスト−歩合）").font = f(bold=True)
rm = ws.cell(row=r, column=4, value=f"=B6-D{cost_row}-D{buai_row}"); rm.font = f(bold=True); rm.number_format = GIL
rem_row = r
ws.conditional_formatting.add(f"D{rem_row}", CellIsRule(operator="lessThan", formula=["0"], fill=PatternFill("solid", fgColor="F8696B")))
ws.conditional_formatting.add(f"D{rem_row}", CellIsRule(operator="greaterThanOrEqual", formula=["0"], fill=PatternFill("solid", fgColor="C6EFCE")))
r += 2
ws.cell(row=r, column=1, value="■ 読み方").font = f(bold=True, color="1F3864"); r += 1
for t in ["身分給(会員数)が先に予算を食う → 役職は“その残り”で雇う",
          "残予算マイナス＝シンク不足。カジノ接続 or サブスク増 or 会員増で枠が開く",
          "星導官は完全歩合＝定員を増やしても固定費は増えない（働いた分のみ）"]:
    ws.cell(row=r, column=1, value="・" + t).font = f(size=9, color=NOTE); r += 1

# 並び順
wb.move_sheet("説明", -wb.sheetnames.index("説明"))
wb.save("casino-finance-model-v2.xlsx")
print("saved")
