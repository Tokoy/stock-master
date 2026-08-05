/* ============================================================
 * chart.js —— K线图渲染（Canvas，深色富途风格）
 * 红涨绿跌、MA5/MA10 均线、成交量、十字光标 + OHLC 提示
 * ============================================================ */
'use strict';

const MAX_BARS = 120; // 最多显示最近 120 根，右侧对齐滚动

class KLineChart {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.bars = [];
    this.marks = [];        // 交易标记 { index, type: 'B' | 'S' }
    this.events = [];       // 事件标记 { index, emoji, text, type, dir }
    this.curPrice = null;   // 当前股价（用于现价虚线）
    this.costPrice = null;  // 当前持仓成本价（用于成本虚线，空仓为 null）
    this.hover = null; // { index, x, y }
    this.dpr = window.devicePixelRatio || 1;

    // roundRect 兼容
    if (!this.ctx.roundRect) {
      this.ctx.roundRect = function (x, y, w, h, r) {
        this.moveTo(x + r, y);
        this.arcTo(x + w, y, x + w, y + h, r);
        this.arcTo(x + w, y + h, x, y + h, r);
        this.arcTo(x, y + h, x, y, r);
        this.arcTo(x, y, x + w, y, r);
        this.closePath();
      };
    }

    this._resize();
    this._bindEvents();
  }

  _resize() {
    const rect = this.canvas.parentElement.getBoundingClientRect();
    this.w = rect.width;
    this.h = rect.height;
    this.canvas.width = Math.round(this.w * this.dpr);
    this.canvas.height = Math.round(this.h * this.dpr);
    this.canvas.style.width = this.w + 'px';
    this.canvas.style.height = this.h + 'px';
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this.draw();
  }

  _bindEvents() {
    this.canvas.addEventListener('mousemove', (e) => {
      const rect = this.canvas.getBoundingClientRect();
      this.hover = this._hitTest(e.clientX - rect.left, e.clientY - rect.top);
      this.draw();
    });
    this.canvas.addEventListener('mouseleave', () => {
      this.hover = null;
      this.draw();
    });
    window.addEventListener('resize', () => this._resize());
  }

  setData(bars) {
    this.bars = bars;
    this.draw();
  }

  /* ---------- 添加交易标记（B 买入 / S 卖出） ---------- */
  addMark(index, type) {
    this.marks.push({ index, type });
    if (this.marks.length > 40) this.marks.shift();
    this.draw();
  }

  /* ---------- 添加事件标记（事件卡触发的新闻点） ---------- */
  addEventMark(rec) {
    // rec: { barIndex, emoji, text, type, dir }
    this.events.push(rec);
    if (this.events.length > 30) this.events.shift();
    this.draw();
  }

  /* ---------- 布局 ---------- */
  _layout() {
    const padL = 58, padR = 64, padT = 14;
    const volH = Math.max(48, this.h * 0.18);
    const padB = 26 + volH;
    return {
      padL, padR, padT, padB,
      volTop: this.h - padB,
      volH,
      plotW: this.w - padL - padR,
      plotH: this.h - padT - padB,
    };
  }

  _offset() { return Math.max(0, this.bars.length - MAX_BARS); }

  _priceRange() {
    let min = Infinity, max = -Infinity;
    for (const b of this.bars) {
      min = Math.min(min, b.low);
      max = Math.max(max, b.high);
    }
    if (!isFinite(min)) { min = 0; max = 1; }
    const pad = (max - min) * 0.08 || 1;
    return { min: min - pad, max: max + pad };
  }

  _x(i, L) {
    const off = this._offset();
    const vis = Math.min(this.bars.length, MAX_BARS);
    if (vis <= 1) return L.padL + L.plotW / 2;
    return L.padL + ((i - off) / (vis - 1)) * L.plotW;
  }

  _y(p, L, R) {
    return L.padT + (R.max - p) / (R.max - R.min) * L.plotH;
  }

  _hitTest(x, y) {
    const L = this._layout();
    const n = this.bars.length;
    if (!n) return null;
    const off = this._offset();
    let best = off, bestD = Infinity;
    for (let i = off; i < n; i++) {
      const d = Math.abs(this._x(i, L) - x);
      if (d < bestD) { bestD = d; best = i; }
    }
    if (bestD > 24) return null;
    return { index: best, x, y };
  }

  _fmtTime(i) {
    const total = i + 1;
    const m = Math.floor(total / 60), s = total % 60;
    return String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
  }

  /* ---------- 绘制 ---------- */
  draw() {
    const ctx = this.ctx;
    const L = this._layout();
    const R = this._priceRange();
    const n = this.bars.length;

    // 背景
    ctx.fillStyle = '#101624';
    ctx.fillRect(0, 0, this.w, this.h);

    // 网格 + 价格刻度
    ctx.font = '11px -apple-system, "PingFang SC", sans-serif';
    ctx.textBaseline = 'middle';
    const gridN = 5;
    for (let i = 0; i <= gridN; i++) {
      const p = R.max - (R.max - R.min) * i / gridN;
      const y = this._y(p, L, R);
      ctx.strokeStyle = 'rgba(255,255,255,0.06)';
      ctx.beginPath();
      ctx.moveTo(L.padL, y);
      ctx.lineTo(this.w - L.padR, y);
      ctx.stroke();
      ctx.fillStyle = '#7a8499';
      ctx.textAlign = 'right';
      ctx.fillText(p.toFixed(2), L.padL - 8, y);
    }

    if (n === 0) return;

    const bw = Math.max(2, L.plotW / MAX_BARS * 0.62);

    // 均线
    const drawMA = (period, color) => {
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      let started = false;
      for (let i = 0; i < n; i++) {
        if (i < period - 1) { started = false; continue; }
        let s = 0;
        for (let j = i - period + 1; j <= i; j++) s += this.bars[j].close;
        const ma = s / period;
        const x = this._x(i, L), y = this._y(ma, L, R);
        if (!started) { ctx.moveTo(x, y); started = true; }
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
    };
    drawMA(5, '#f7b731');
    drawMA(10, '#7d5fff');

    // 蜡烛
    for (let i = 0; i < n; i++) {
      const b = this.bars[i];
      const x = this._x(i, L);
      const up = b.close >= b.open;
      const color = up ? '#ff4d4f' : '#2ebd85';
      ctx.strokeStyle = color;
      ctx.fillStyle = color;
      // 影线
      ctx.beginPath();
      ctx.moveTo(x, this._y(b.high, L, R));
      ctx.lineTo(x, this._y(b.low, L, R));
      ctx.stroke();
      // 实体
      const yO = this._y(b.open, L, R), yC = this._y(b.close, L, R);
      const top = Math.min(yO, yC), h = Math.max(1, Math.abs(yO - yC));
      ctx.fillRect(x - bw / 2, top, bw, h);
      // hover 高亮
      if (this.hover && this.hover.index === i) {
        ctx.strokeStyle = 'rgba(255,255,255,0.85)';
        ctx.lineWidth = 1;
        ctx.strokeRect(x - bw / 2 - 1, top - 1, bw + 2, h + 2);
      }
    }

    // 成交量
    let maxVol = 0;
    for (const b of this.bars) maxVol = Math.max(maxVol, b.volume);
    for (let i = 0; i < n; i++) {
      const b = this.bars[i];
      const x = this._x(i, L);
      const vh = (b.volume / maxVol) * (L.volH - 8);
      const up = b.close >= b.open;
      ctx.fillStyle = up ? 'rgba(255,77,79,0.55)' : 'rgba(46,189,133,0.55)';
      ctx.fillRect(x - bw / 2, L.volTop + (L.volH - vh), bw, vh);
    }

    // 时间轴（首 / 中 / 尾）
    ctx.fillStyle = '#7a8499';
    ctx.textAlign = 'center';
    const off = this._offset();
    ctx.fillText(this._fmtTime(off), this._x(off, L), this.h - 12);
    if (n > 2) {
      ctx.fillText(this._fmtTime(Math.floor((off + n) / 2)), this._x(Math.floor((off + n) / 2), L), this.h - 12);
      ctx.fillText(this._fmtTime(n - 1), this._x(n - 1, L), this.h - 12);
    }

    // 十字光标 + OHLC 提示
    if (this.hover && this.hover.index >= off && this.hover.index < n) {
      const b = this.bars[this.hover.index];
      const x = this._x(this.hover.index, L);
      ctx.strokeStyle = 'rgba(255,255,255,0.35)';
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(x, L.padT);
      ctx.lineTo(x, this.h - L.padB);
      ctx.stroke();
      ctx.setLineDash([]);

      const up = b.close >= b.open;
      const change = (b.close - b.open) / b.open * 100;
      const lines = [
        '时间 ' + this._fmtTime(this.hover.index),
        '开 ' + b.open.toFixed(2),
        '高 ' + b.high.toFixed(2),
        '低 ' + b.low.toFixed(2),
        '收 ' + b.close.toFixed(2),
        '涨跌 ' + (change >= 0 ? '+' : '') + change.toFixed(2) + '%',
        '量 ' + Math.round(b.volume),
      ];
      const tw = 108, lh = 17;
      const th = lines.length * lh + 10;
      let tx = x + 12;
      if (tx + tw > this.w - 4) tx = x - tw - 12;
      let ty = this.hover.y - th / 2;
      ty = Math.max(L.padT, Math.min(this.h - L.padB - th, ty));

      ctx.fillStyle = 'rgba(22,28,44,0.95)';
      ctx.strokeStyle = 'rgba(255,255,255,0.15)';
      ctx.beginPath();
      ctx.roundRect(tx, ty, tw, th, 6);
      ctx.fill();
      ctx.stroke();
      ctx.textAlign = 'left';
      lines.forEach((ln, idx) => {
        if (idx === 5) {
          ctx.fillStyle = up ? '#ff6b6b' : '#3ddc97';
        } else {
          ctx.fillStyle = '#aab4c8';
        }
        ctx.fillText(ln, tx + 8, ty + 16 + idx * lh);
      });
    }

    /* ---------- 现价虚线 + 成本虚线 ---------- */
    const price = this.curPrice != null ? this.curPrice : (n ? this.bars[n - 1].close : null);
    let priceLabelY = null;
    if (price != null) {
      const last = this.bars[n - 1];
      const up = last.close >= last.open;
      const color = up ? '#ff4d4f' : '#2ebd85';
      const y = this._y(price, L, R);
      priceLabelY = Math.max(L.padT + 9, Math.min(this.h - L.padB - 9, y));

      ctx.strokeStyle = color;
      ctx.globalAlpha = 0.75;
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(L.padL, y);
      ctx.lineTo(this.w - L.padR, y);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;

      // 右轴现价标签
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.roundRect(this.w - L.padR + 4, priceLabelY - 9, L.padR - 8, 18, 4);
      ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.font = 'bold 11px -apple-system, "PingFang SC", sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(price.toFixed(2), this.w - L.padR / 2 + 2, priceLabelY);
      ctx.textBaseline = 'alphabetic';
    }

    if (this.costPrice != null) {
      const y = this._y(this.costPrice, L, R);
      let labelY = Math.max(L.padT + 9, Math.min(this.h - L.padB - 9, y));
      // 与现价标签错开，避免重叠
      if (priceLabelY != null && Math.abs(labelY - priceLabelY) < 24) {
        labelY = priceLabelY + (labelY > priceLabelY ? 24 : -24);
      }

      ctx.strokeStyle = '#f0b90b';
      ctx.globalAlpha = 0.85;
      ctx.setLineDash([6, 4]);
      ctx.beginPath();
      ctx.moveTo(L.padL, y);
      ctx.lineTo(this.w - L.padR, y);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;

      // 右轴成本标签
      ctx.fillStyle = 'rgba(24,32,54,0.95)';
      ctx.strokeStyle = 'rgba(240,185,11,0.65)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.roundRect(this.w - L.padR + 4, labelY - 9, L.padR - 8, 18, 4);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = '#f0b90b';
      ctx.font = 'bold 11px -apple-system, "PingFang SC", sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('成本 ' + this.costPrice.toFixed(2), this.w - L.padR / 2 + 2, labelY);
      ctx.textBaseline = 'alphabetic';
    }

    /* ---------- B/S 交易标记 ---------- */
    if (this.marks.length) {
      // 按K线聚合（同一根上可能有多个标记，向上错开堆叠）
      const byIndex = new Map();
      for (const mk of this.marks) {
        if (mk.index < off || mk.index >= n) continue;
        if (!byIndex.has(mk.index)) byIndex.set(mk.index, []);
        byIndex.get(mk.index).push(mk.type);
      }
      ctx.font = 'bold 11px -apple-system, "PingFang SC", sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      for (const [idx, types] of byIndex) {
        const b = this.bars[idx];
        const x = this._x(idx, L);
        const yBase = this._y(b.high, L, R);
        types.forEach((t, k) => {
          const y = Math.max(L.padT + 8, yBase - 15 - k * 18);
          const color = t === 'B' ? '#ff4d4f' : '#2ebd85';
          // 竖虚线：K线顶 → 徽章
          ctx.setLineDash([2, 3]);
          ctx.strokeStyle = color;
          ctx.globalAlpha = 0.8;
          ctx.beginPath();
          ctx.moveTo(x, yBase - 1);
          ctx.lineTo(x, y + 14);
          ctx.stroke();
          ctx.setLineDash([]);
          ctx.globalAlpha = 1;
          // 徽章
          ctx.fillStyle = color;
          ctx.beginPath();
          ctx.roundRect(x - 9, y, 18, 16, 4);
          ctx.fill();
          ctx.strokeStyle = 'rgba(255,255,255,0.55)';
          ctx.lineWidth = 1;
          ctx.stroke();
          ctx.fillStyle = '#fff';
          ctx.fillText(t, x, y + 8);
        });
      }
      ctx.textBaseline = 'alphabetic';
    }

    /* ---------- 事件标记（K线顶部 ⓘ 徽章） ---------- */
    if (this.events.length) {
      ctx.font = '12px -apple-system, "PingFang SC", sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      for (const ev of this.events) {
        if (ev.barIndex < off || ev.barIndex >= n) continue;
        const b = this.bars[ev.barIndex];
        const x = this._x(ev.barIndex, L);
        const y = Math.max(L.padT + 10, this._y(b.high, L, R) - 12);
        // 气泡背景：涨红跌绿
        const bubble = ev.dir === 'up' ? '#e02428' : (ev.dir === 'down' ? '#0f9d6a' : '#f0b90b');
        ctx.fillStyle = bubble;
        ctx.beginPath();
        ctx.arc(x, y, 9, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = 'rgba(255,255,255,0.7)';
        ctx.lineWidth = 1;
        ctx.stroke();
        // emoji 图标
        ctx.font = '11px -apple-system, "PingFang SC", sans-serif';
        ctx.fillText(ev.emoji || 'ⓘ', x, y + 0.5);
      }
      ctx.textBaseline = 'alphabetic';
    }

    // 图例（右轴顶部）
    ctx.font = '10px -apple-system, "PingFang SC", sans-serif';
    ctx.textAlign = 'left';
    ctx.fillStyle = '#7a8499';
    ctx.fillText('MA5', this.w - L.padR + 8, 16);
    ctx.fillStyle = '#f7b731';
    ctx.fillText('—', this.w - L.padR + 36, 16);
    ctx.fillStyle = '#7a8499';
    ctx.fillText('MA10', this.w - L.padR + 8, 30);
    ctx.fillStyle = '#7d5fff';
    ctx.fillText('—', this.w - L.padR + 36, 30);
  }
}
