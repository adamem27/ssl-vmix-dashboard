/** Today's date (YYYY-MM-DD) in the given IANA time zone. */
export function todayIn(tz) {
    try {
        return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
    }
    catch {
        return new Date().toISOString().slice(0, 10);
    }
}
