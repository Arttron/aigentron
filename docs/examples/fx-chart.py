#!/usr/bin/env python3
"""
EUR/UAH chart for a Schedules → "Run a script" job (ПриватБанк, cash and card), no AI involved.

Every run: asks PrivatBank's public API for today's EUR rates (cash coursid=5, card coursid=11), appends one row to a history file kept between runs
($LDS_DATA_DIR/fx-history.csv), draws the last 14 days and leaves the picture in $LDS_OUTPUT_DIR — the server posts it to the schedule's chat and deletes it.
What the script prints is the caption of the picture.

Needs python3 + matplotlib on the server (`pip install matplotlib`). Set a CURRENCY below to chart another one.
"""
import csv
import json
import os
import sys
import urllib.request
from datetime import datetime, timedelta

CURRENCY = os.environ.get("FX_CURRENCY", "EUR")
DAYS = int(os.environ.get("FX_DAYS", "14"))
DATA_DIR = os.environ.get("LDS_DATA_DIR", ".")
OUT_DIR = os.environ.get("LDS_OUTPUT_DIR", ".")
HISTORY = os.path.join(DATA_DIR, f"fx-{CURRENCY.lower()}-history.csv")
API = "https://api.privatbank.ua/p24api/pubinfo?json&exchange&coursid={}"
FIELDS = ["time", "cash_buy", "cash_sale", "card_buy", "card_sale"]


def rate(coursid: int) -> tuple[float, float]:
    with urllib.request.urlopen(API.format(coursid), timeout=20) as r:
        rows = json.load(r)
    for row in rows:
        if row.get("ccy") == CURRENCY and row.get("base_ccy") == "UAH":
            return float(row["buy"]), float(row["sale"])
    raise SystemExit(f"no {CURRENCY}/UAH rate in the answer of coursid={coursid}")


def load() -> list[dict]:
    if not os.path.exists(HISTORY):
        return []
    with open(HISTORY, newline="", encoding="utf-8") as f:
        return list(csv.DictReader(f))


def main() -> None:
    os.makedirs(DATA_DIR, exist_ok=True)
    os.makedirs(OUT_DIR, exist_ok=True)
    cash_buy, cash_sale = rate(5)
    card_buy, card_sale = rate(11)
    now = datetime.now().replace(microsecond=0)
    rows = load()
    rows.append({"time": now.isoformat(), "cash_buy": cash_buy, "cash_sale": cash_sale, "card_buy": card_buy, "card_sale": card_sale})
    rows = rows[-1500:]  # about a year at one run a day, months at a few a day
    with open(HISTORY, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=FIELDS)
        w.writeheader()
        w.writerows(rows)

    since = now - timedelta(days=DAYS)
    recent = [r for r in rows if datetime.fromisoformat(r["time"]) >= since] or rows[-1:]
    xs = [datetime.fromisoformat(r["time"]) for r in recent]

    import matplotlib

    matplotlib.use("Agg")  # no display on a server
    import matplotlib.dates as mdates
    import matplotlib.pyplot as plt

    fig, ax = plt.subplots(figsize=(9, 4.5), dpi=130)
    for key, label, color in (("cash_sale", "наличные (продажа)", "#2f6fdb"), ("card_sale", "карта (продажа)", "#d9822b")):
        ys = [float(r[key]) for r in recent]
        ax.plot(xs, ys, marker="o", markersize=3, linewidth=1.8, label=label, color=color)
        ax.annotate(f"{ys[-1]:.2f}", (xs[-1], ys[-1]), textcoords="offset points", xytext=(6, 6), fontsize=9, color=color, fontweight="bold")
    ax.set_title(f"{CURRENCY}/UAH, ПриватБанк · последние {DAYS} дн. (точек: {len(recent)})")
    ax.margins(x=0.1, y=0.15)  # room for the labels of the last points
    ax.grid(alpha=0.3)
    ax.legend(loc="best")
    ax.xaxis.set_major_formatter(mdates.DateFormatter("%d.%m"))
    fig.autofmt_xdate()
    fig.tight_layout()
    fig.savefig(os.path.join(OUT_DIR, f"{CURRENCY.lower()}-uah.png"))

    print(f"{CURRENCY}/UAH ПриватБанк: наличные {cash_buy:.2f} / {cash_sale:.2f}, карта {card_buy:.2f} / {card_sale:.2f} (покупка / продажа)")


if __name__ == "__main__":
    try:
        main()
    except Exception as e:  # the server shows the last lines of output in the chat when a run fails
        print(f"fx-chart failed: {e}", file=sys.stderr)
        sys.exit(1)
