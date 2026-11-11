/** The day picked at the top of the dashboard (YYYY-MM-DD), '' = the real today. Every "today" follows it. */
let dayOverride = '';
export const DAY_SETTING = 'dashboard.day';
export function setDayOverride(day) { dayOverride = /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : ''; }
export function dayOverrideNow() { return dayOverride; }
/** Today's date (YYYY-MM-DD) in the given IANA time zone, or the day picked at the top of the dashboard. */
export function todayIn(tz) {
    if (dayOverride)
        return dayOverride;
    return realTodayIn(tz);
}
/** The calendar's today, whatever day is picked. */
export function realTodayIn(tz) {
    try {
        return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
    }
    catch {
        return new Date().toISOString().slice(0, 10);
    }
}
