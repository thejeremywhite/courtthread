"use client";

import { useState, useEffect, useRef } from "react";

interface DateTimePickerProps {
  value: string;
  onChange: (iso: string) => void;
  label?: string;
  placeholder?: string;
}

const HOURS_12 = ["12", "1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11"];
const HOURS_24 = Array.from({ length: 24 }, (_, i) => i.toString().padStart(2, "0"));
const MINUTES_15 = ["00", "15", "30", "45"];
const MINUTES_60 = Array.from({ length: 60 }, (_, i) => i.toString().padStart(2, "0"));
const SECONDS_60 = Array.from({ length: 60 }, (_, i) => i.toString().padStart(2, "0"));
const HUNDREDTHS = Array.from({ length: 100 }, (_, i) => i.toString().padStart(2, "0"));

const MONTH_NAMES = ["January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December"];
const MONTH_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DAY_NAMES = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];

function daysInMonth(year: number, month: number) {
  return new Date(year, month + 1, 0).getDate();
}

type CalendarView = "days" | "months" | "years";

export function DateTimePicker({ value, onChange, label, placeholder }: DateTimePickerProps) {
  const [open, setOpen] = useState(false);
  const [date, setDate] = useState("");
  const [hour, setHour] = useState("12");
  const [minute, setMinute] = useState("00");
  const [second, setSecond] = useState("00");
  const [hundredth, setHundredth] = useState("00");
  const [period, setPeriod] = useState<"AM" | "PM">("AM");
  const [exactTime, setExactTime] = useState(false);
  const [use24h, setUse24h] = useState(false);
  const popRef = useRef<HTMLDivElement>(null);

  // Calendar navigation state — lifted out of CalendarGrid so Done can use it
  const today = new Date();
  const [viewYear, setViewYear] = useState(today.getFullYear());
  const [viewMonth, setViewMonth] = useState(today.getMonth());
  const [calView, setCalView] = useState<CalendarView>("days");
  const [yearRangeStart, setYearRangeStart] = useState(Math.floor(today.getFullYear() / 12) * 12);

  // Sync internal state from prop value
  useEffect(() => {
    if (!value) { setDate(""); return; }
    const d = new Date(value);
    if (isNaN(d.getTime())) return;
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    const dateStr = `${yyyy}-${mm}-${dd}`;
    setDate(dateStr);
    setViewYear(yyyy);
    setViewMonth(d.getMonth());
    setYearRangeStart(Math.floor(yyyy / 12) * 12);
    let h = d.getHours();
    const m = d.getMinutes();
    const s = d.getSeconds();
    const ms = d.getMilliseconds();
    setPeriod(h >= 12 ? "PM" : "AM");
    if (use24h) {
      setHour(h.toString().padStart(2, "0"));
    } else {
      h = h % 12 || 12;
      setHour(h.toString());
    }
    setMinute(m.toString().padStart(2, "0"));
    setSecond(s.toString().padStart(2, "0"));
    setHundredth(Math.floor(ms / 10).toString().padStart(2, "0"));
    if (s > 0 || ms > 0 || !MINUTES_15.includes(m.toString().padStart(2, "0"))) {
      setExactTime(true);
    }
  }, [value]);

  // When opening, sync calendar view to current date or today
  useEffect(() => {
    if (open) {
      if (date) {
        const d = new Date(date + "T00:00:00");
        setViewYear(d.getFullYear());
        setViewMonth(d.getMonth());
        setYearRangeStart(Math.floor(d.getFullYear() / 12) * 12);
      } else {
        setViewYear(today.getFullYear());
        setViewMonth(today.getMonth());
        setYearRangeStart(Math.floor(today.getFullYear() / 12) * 12);
      }
      setCalView("days");
    }
  }, [open]);

  // Outside click to close
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (popRef.current && !popRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  function toHour24(h: string, p: "AM" | "PM"): number {
    if (use24h) return parseInt(h);
    let hour24 = parseInt(h);
    if (p === "PM" && hour24 !== 12) hour24 += 12;
    if (p === "AM" && hour24 === 12) hour24 = 0;
    return hour24;
  }

  function buildIso(dateStr: string, h: string, m: string, s: string, hs: string, p: "AM" | "PM"): string {
    if (!dateStr) return "";
    const hour24 = toHour24(h, p);
    const d = new Date(`${dateStr}T${hour24.toString().padStart(2, "0")}:${m.padStart(2, "0")}:${s.padStart(2, "0")}`);
    if (isNaN(d.getTime())) return "";
    d.setMilliseconds(parseInt(hs) * 10);
    return d.toISOString();
  }

  function commit(dateStr: string, h: string, m: string, s: string, hs: string, p: "AM" | "PM") {
    const iso = buildIso(dateStr, h, m, s, hs, p);
    if (iso) onChange(iso);
  }

  function handleDateSelect(dateStr: string) {
    setDate(dateStr);
    commit(dateStr, hour, minute, second, hundredth, period);
  }

  function update(field: string, val: string) {
    const h = field === "hour" ? val : hour;
    const m = field === "minute" ? val : minute;
    const s = field === "second" ? val : second;
    const hs = field === "hundredth" ? val : hundredth;
    const p = field === "period" ? val as "AM" | "PM" : period;
    if (field === "hour") setHour(val);
    if (field === "minute") setMinute(val);
    if (field === "second") setSecond(val);
    if (field === "hundredth") setHundredth(val);
    if (field === "period") setPeriod(val as "AM" | "PM");
    commit(date, h, m, s, hs, p);
  }

  function toggle24h() {
    const newUse24h = !use24h;
    setUse24h(newUse24h);
    if (newUse24h) {
      const h24 = toHour24(hour, period);
      setHour(h24.toString().padStart(2, "0"));
    } else {
      const h24 = parseInt(hour);
      setPeriod(h24 >= 12 ? "PM" : "AM");
      const h12 = h24 % 12 || 12;
      setHour(h12.toString());
    }
  }

  function handleDone() {
    if (!date) {
      const autoDate = `${viewYear}-${(viewMonth + 1).toString().padStart(2, "0")}-01`;
      setDate(autoDate);
      commit(autoDate, hour, minute, second, hundredth, period);
    } else {
      const currentDateParts = date.split("-");
      const currentYear = parseInt(currentDateParts[0]);
      const currentMonth = parseInt(currentDateParts[1]) - 1;
      if (currentYear !== viewYear || currentMonth !== viewMonth) {
        const autoDate = `${viewYear}-${(viewMonth + 1).toString().padStart(2, "0")}-01`;
        setDate(autoDate);
        commit(autoDate, hour, minute, second, hundredth, period);
      }
    }
    setOpen(false);
  }

  function handleClear() {
    onChange("");
    setDate("");
    setOpen(false);
  }

  const displayValue = (() => {
    if (!value) return placeholder || "Select date & time";
    const d = new Date(value);
    if (isNaN(d.getTime())) return placeholder || "Select date & time";
    const dateStr = d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
    const ms = d.getMilliseconds();
    const s = d.getSeconds();
    if (use24h) {
      const hh = d.getHours().toString().padStart(2, "0");
      const mm = d.getMinutes().toString().padStart(2, "0");
      const sec = s > 0 || ms > 0 ? ":" + s.toString().padStart(2, "0") : "";
      const frac = ms > 0 ? "." + Math.floor(ms / 10).toString().padStart(2, "0") : "";
      return `${dateStr} ${hh}:${mm}${sec}${frac}`;
    }
    const h = d.getHours();
    const h12 = h % 12 || 12;
    const mm = d.getMinutes().toString().padStart(2, "0");
    const p = h >= 12 ? "PM" : "AM";
    const sec = s > 0 || ms > 0 ? ":" + s.toString().padStart(2, "0") : "";
    const frac = ms > 0 ? "." + Math.floor(ms / 10).toString().padStart(2, "0") : "";
    return `${dateStr} ${h12}:${mm}${sec}${frac} ${p}`;
  })();

  const minuteOptions = exactTime ? MINUTES_60 : MINUTES_15;
  const hourOptions = use24h ? HOURS_24 : HOURS_12;

  // Calendar rendering
  const selectedDateStr = date;

  function renderDays() {
    const firstDay = new Date(viewYear, viewMonth, 1).getDay();
    const totalDays = daysInMonth(viewYear, viewMonth);
    const cells: (number | null)[] = [];
    for (let i = 0; i < firstDay; i++) cells.push(null);
    for (let d = 1; d <= totalDays; d++) cells.push(d);

    return (
      <div>
        <div className="flex items-center justify-between mb-2">
          <button type="button" onClick={() => {
            if (viewMonth === 0) { setViewMonth(11); setViewYear(viewYear - 1); }
            else setViewMonth(viewMonth - 1);
          }} className="px-2 py-1 text-[var(--muted-foreground)] hover:text-[var(--foreground)] transition">&lt;</button>
          <button type="button" onClick={() => setCalView("months")}
            className="text-sm font-medium hover:text-[var(--primary)] transition">
            {MONTH_NAMES[viewMonth]} {viewYear}
          </button>
          <button type="button" onClick={() => {
            if (viewMonth === 11) { setViewMonth(0); setViewYear(viewYear + 1); }
            else setViewMonth(viewMonth + 1);
          }} className="px-2 py-1 text-[var(--muted-foreground)] hover:text-[var(--foreground)] transition">&gt;</button>
        </div>
        <div className="grid grid-cols-7 gap-0.5 text-center">
          {DAY_NAMES.map((d) => (
            <div key={d} className="text-[10px] text-[var(--muted-foreground)] font-medium py-1">{d}</div>
          ))}
          {cells.map((day, i) => {
            if (day === null) return <div key={`empty-${i}`} />;
            const ds = `${viewYear}-${(viewMonth + 1).toString().padStart(2, "0")}-${day.toString().padStart(2, "0")}`;
            const isSelected = ds === selectedDateStr;
            const isToday = day === today.getDate() && viewMonth === today.getMonth() && viewYear === today.getFullYear();
            return (
              <button type="button" key={ds} onClick={() => handleDateSelect(ds)}
                className={`text-xs py-1.5 rounded transition ${
                  isSelected
                    ? "bg-[var(--primary)] text-white font-bold"
                    : isToday
                      ? "bg-[var(--secondary)] font-bold"
                      : "hover:bg-[var(--secondary)]"
                }`}>
                {day}
              </button>
            );
          })}
        </div>
      </div>
    );
  }

  function renderMonths() {
    const sel = selectedDateStr ? new Date(selectedDateStr + "T00:00:00") : null;
    return (
      <div>
        <div className="flex items-center justify-between mb-3">
          <button type="button" onClick={() => setViewYear(viewYear - 1)}
            className="px-2 py-1 text-[var(--muted-foreground)] hover:text-[var(--foreground)] transition">&lt;</button>
          <button type="button" onClick={() => { setYearRangeStart(Math.floor(viewYear / 12) * 12); setCalView("years"); }}
            className="text-sm font-medium hover:text-[var(--primary)] transition">
            {viewYear}
          </button>
          <button type="button" onClick={() => setViewYear(viewYear + 1)}
            className="px-2 py-1 text-[var(--muted-foreground)] hover:text-[var(--foreground)] transition">&gt;</button>
        </div>
        <div className="grid grid-cols-3 gap-2">
          {MONTH_SHORT.map((name, i) => {
            const isCurrent = sel && i === sel.getMonth() && viewYear === sel.getFullYear();
            return (
              <button type="button" key={name} onClick={() => { setViewMonth(i); setCalView("days"); }}
                className={`py-2 rounded text-sm transition ${
                  isCurrent
                    ? "bg-[var(--primary)] text-white font-bold"
                    : "hover:bg-[var(--secondary)]"
                }`}>
                {name}
              </button>
            );
          })}
        </div>
      </div>
    );
  }

  function renderYears() {
    return (
      <div>
        <div className="flex items-center justify-between mb-3">
          <button type="button" onClick={() => setYearRangeStart(yearRangeStart - 12)}
            className="px-2 py-1 text-[var(--muted-foreground)] hover:text-[var(--foreground)] transition">&lt;</button>
          <span className="text-sm font-medium">
            {yearRangeStart} – {yearRangeStart + 11}
          </span>
          <button type="button" onClick={() => setYearRangeStart(yearRangeStart + 12)}
            className="px-2 py-1 text-[var(--muted-foreground)] hover:text-[var(--foreground)] transition">&gt;</button>
        </div>
        <div className="grid grid-cols-3 gap-2">
          {Array.from({ length: 12 }, (_, i) => yearRangeStart + i).map((yr) => {
            const isCurrent = yr === viewYear;
            return (
              <button type="button" key={yr} onClick={() => { setViewYear(yr); setCalView("months"); }}
                className={`py-2 rounded text-sm transition ${
                  isCurrent
                    ? "bg-[var(--primary)] text-white font-bold"
                    : "hover:bg-[var(--secondary)]"
                }`}>
                {yr}
              </button>
            );
          })}
        </div>
      </div>
    );
  }

  return (
    <div className="relative" ref={popRef}>
      {label && <label className="text-xs text-[var(--muted-foreground)] mb-1 block">{label}</label>}
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className={`w-full text-left px-3 py-1.5 rounded-lg border text-sm transition ${
          value ? "border-[var(--primary)]/50 text-[var(--foreground)]" : "border-[var(--border)] text-[var(--muted-foreground)]"
        } bg-[var(--background)] hover:border-[var(--primary)]`}
      >
        {displayValue}
      </button>

      {open && (
        <div className="absolute z-50 top-full left-0 mt-1 rounded-xl border border-[var(--border)] bg-[var(--card)] shadow-2xl w-72">
          {/* Calendar */}
          <div className="p-3 border-b border-[var(--border)]">
            {calView === "days" && renderDays()}
            {calView === "months" && renderMonths()}
            {calView === "years" && renderYears()}
          </div>

          {/* Time picker */}
          <div className="p-3 border-b border-[var(--border)]">
            <div className="flex items-center justify-between mb-2">
              <p className="text-[10px] font-medium text-[var(--muted-foreground)] uppercase tracking-wider">Time</p>
              <div className="flex gap-2">
                <label className="flex items-center gap-1 cursor-pointer">
                  <input type="checkbox" checked={exactTime} onChange={(e) => {
                    setExactTime(e.target.checked);
                    if (!e.target.checked) { setSecond("00"); setHundredth("00"); }
                  }} className="rounded w-3 h-3" />
                  <span className="text-[10px] text-[var(--muted-foreground)]">Exact</span>
                </label>
                <label className="flex items-center gap-1 cursor-pointer">
                  <input type="checkbox" checked={use24h} onChange={toggle24h} className="rounded w-3 h-3" />
                  <span className="text-[10px] text-[var(--muted-foreground)]">24h</span>
                </label>
              </div>
            </div>
            <div className="flex gap-1 items-center flex-wrap">
              <select value={hour} onChange={(e) => update("hour", e.target.value)}
                className="w-14 px-1 py-1.5 rounded border border-[var(--border)] bg-[var(--background)] text-sm">
                {hourOptions.map((h) => <option key={h} value={h}>{h}</option>)}
              </select>
              <span className="text-[var(--muted-foreground)] font-bold">:</span>
              <select value={minute} onChange={(e) => update("minute", e.target.value)}
                className="w-14 px-1 py-1.5 rounded border border-[var(--border)] bg-[var(--background)] text-sm">
                {minuteOptions.map((m) => <option key={m} value={m}>{m}</option>)}
              </select>
              {exactTime && (
                <>
                  <span className="text-[var(--muted-foreground)] font-bold">:</span>
                  <select value={second} onChange={(e) => update("second", e.target.value)}
                    className="w-14 px-1 py-1.5 rounded border border-[var(--border)] bg-[var(--background)] text-sm">
                    {SECONDS_60.map((s) => <option key={s} value={s}>{s}</option>)}
                  </select>
                  <span className="text-[var(--muted-foreground)] font-bold">.</span>
                  <select value={hundredth} onChange={(e) => update("hundredth", e.target.value)}
                    className="w-14 px-1 py-1.5 rounded border border-[var(--border)] bg-[var(--background)] text-sm">
                    {HUNDREDTHS.map((h) => <option key={h} value={h}>{h}</option>)}
                  </select>
                </>
              )}
              {!use24h && (
                <select value={period} onChange={(e) => update("period", e.target.value)}
                  className="w-14 px-1 py-1.5 rounded border border-[var(--border)] bg-[var(--background)] text-sm">
                  <option value="AM">AM</option>
                  <option value="PM">PM</option>
                </select>
              )}
            </div>
          </div>

          {/* Footer */}
          <div className="p-2 flex items-center justify-end gap-1">
            <button type="button" onClick={handleClear}
              className="text-xs px-2 py-1 text-[var(--destructive)] hover:underline">
              Clear
            </button>
            <button type="button" onClick={handleDone}
              className="text-xs px-3 py-1 rounded bg-[var(--primary)] text-white hover:opacity-90">
              Done
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
