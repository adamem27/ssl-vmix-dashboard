const v = (...labels) => labels.map((l) => ({ id: l.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''), label: l }));
const one = v('Default');
export const SCENES = [
    { id: 'welcome', name: 'Welcome graphic', group: 'Full screen', variants: one },
    { id: 'day-schedule', name: 'Day schedule', group: 'Full screen', variants: v('2 races', '2 races, no time', '3 races', '3 races, no time', '4 races', '4 races, no time') },
    { id: 'weather', name: 'Weather', group: 'Full screen', variants: one },
    { id: 'announcement', name: 'Announcement (bug / ticker)', group: 'Announcements', variants: v('Bug', 'Ticker top', 'Ticker bottom') },
    { id: 'warning-signal', name: 'Warning signal', group: 'Announcements', variants: one },
    { id: 'delay-weather', name: 'Delay – weather', group: 'Announcements', variants: one },
    { id: 'delay-other', name: 'Delay – other reasons', group: 'Announcements', variants: one },
    { id: 'thanks', name: 'Thanks for watching', group: 'Announcements', variants: one },
    { id: 'custom-text', name: 'Custom text', group: 'Announcements', variants: one },
    { id: 'race-postponed', name: 'Race postponed', group: 'Announcements', variants: one },
    { id: 'race-abandoned', name: 'Race abandoned', group: 'Announcements', variants: one },
    { id: 'falstart', name: 'Falstart', group: 'Announcements', variants: one },
    { id: 'penalty', name: 'Penalty', group: 'Announcements', variants: one },
    { id: 'general-recall', name: 'General recall', group: 'Announcements', variants: one },
    { id: 'individual-recall', name: 'Individual recall', group: 'Announcements', variants: one },
    { id: 'replay', name: 'Replay', group: 'Announcements', variants: one },
    { id: 'race-officials', name: 'Race officials', group: 'Full screen', variants: one },
    { id: 'race-course', name: 'Race course', group: 'Full screen', variants: v('1x', '2x', 'Horizontal 1x', 'Horizontal 2x', 'Vertical 1x', 'Vertical 2x') },
    { id: 'team-comparison', name: 'Team comparison', group: 'Teams', variants: v('3 teams', '4 teams') },
    { id: 'group-results', name: 'Group overall results', group: 'Teams', variants: v('3 teams', '4 teams') },
    { id: 'l-bars', name: 'L-bars', group: 'L-bars', variants: one },
    { id: 'socials', name: 'Socials (follow us)', group: 'Full screen', variants: one },
    { id: 'team-lineup', name: 'Team line-up', group: 'Teams', variants: v('8 sailors', '9 sailors', '10 sailors') },
    { id: 'lt-sailor', name: 'Lower third – sailor', group: 'Lower thirds', variants: v('Photo', 'No photo', 'Photo + sponsor', 'No photo + sponsor') },
    { id: 'lt-team', name: 'Lower third – team', group: 'Lower thirds', variants: v('Normal', 'Qualified') },
    { id: 'lt-commentator', name: 'Lower third – commentator', group: 'Lower thirds', variants: v('Photo', 'No photo') },
    { id: 'matchboard', name: 'Matchboard', group: 'Teams', variants: one },
    { id: 'l-bars-combo', name: 'L-bars + tickers + schedule / overall results', group: 'L-bars', variants: v('Schedule', 'Overall results') },
];
export function sceneLabel(scene, variant) {
    const s = SCENES.find((x) => x.id === scene);
    if (!s)
        return null;
    const vv = s.variants.find((x) => x.id === variant);
    return vv && s.variants.length > 1 ? `${s.name} – ${vv.label}` : s.name;
}
/** Best guess of scene and variant from a file name such as “Team_line-up_9_BUL.gtzip” or “day_schedule_2_rows_NO_TIME”. */
export function guessScene(filename) {
    const f = filename.toLowerCase().replace(/\.gtzip$/, '').replace(/[_\-.]+/g, ' ');
    const has = (...w) => w.some((x) => f.includes(x));
    const num = (re) => { const m = re.exec(f); return m ? Number(m[1]) : null; };
    const pick = (scene, variant) => {
        const s = SCENES.find((x) => x.id === scene);
        return { scene, variant: (s.variants.find((x) => x.id === variant) ?? s.variants[0]).id };
    };
    if (has('l bar', 'lbar') && has('ticker', 'schedule', 'result', 'overall'))
        return pick('l-bars-combo', has('result', 'overall') ? 'overall-results' : 'schedule');
    if (has('schedule') && !has('l bar', 'lbar')) {
        const n = num(/(\d)\s*(?:rows?|races?)/) ?? num(/schedule\s*(\d)/);
        return pick('day-schedule', n ? `${n}-races${has('no time', 'notime') ? '-no-time' : ''}` : null);
    }
    if (has('line up', 'lineup'))
        return pick('team-lineup', `${num(/(?:line up|lineup)\s*(\d+)/) ?? 9}-sailors`);
    if (has('comparison'))
        return pick('team-comparison', `${num(/(\d)\s*teams?/) ?? 3}-teams`);
    if (has('overall', 'group result'))
        return pick('group-results', `${num(/(\d)\s*teams?/) ?? 3}-teams`);
    if (has('commentator'))
        return pick('lt-commentator', has('no photo', 'nophoto') ? 'no-photo' : 'photo');
    if (has('official'))
        return pick('race-officials');
    if (has('lowerthird', 'lower third', 'lt ') && has('team'))
        return pick('lt-team', has('qualif') ? 'qualified' : 'normal');
    if (has('lowerthird', 'lower third', 'lt '))
        return pick('lt-sailor', `${has('no photo', 'nophoto') ? 'no-photo' : 'photo'}${has('sponsor') ? '-sponsor' : ''}`);
    if (has('delay'))
        return pick(has('weather', 'wind') ? 'delay-weather' : 'delay-other');
    if (has('announcement', 'ticker'))
        return pick('announcement', has('ticker') ? (has('top') ? 'ticker-top' : 'ticker-bottom') : 'bug');
    const simple = [[['welcome'], 'welcome'], [['weather'], 'weather'], [['warning'], 'warning-signal'], [['thanks', 'thank you'], 'thanks'],
        [['postpone'], 'race-postponed'], [['abandon'], 'race-abandoned'], [['general recall'], 'general-recall'], [['individual recall'], 'individual-recall'],
        [['replay'], 'replay'], [['course'], 'race-course'], [['social', 'follow'], 'socials'], [['matchboard'], 'matchboard'], [['custom'], 'custom-text'],
        [['falstart', 'false start'], 'falstart'], [['penalty'], 'penalty']];
    for (const [w, id] of simple)
        if (has(...w))
            return pick(id, id === 'race-course' ? `${has('horizontal') ? 'horizontal-' : has('vertical') ? 'vertical-' : ''}${has('2x') ? '2x' : '1x'}` : null);
    if (has('l bar', 'lbar'))
        return pick('l-bars');
    return null;
}
