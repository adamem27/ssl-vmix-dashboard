import { describe, expect, it } from 'vitest';
import { setup, seedTeam } from './helpers.js';
import { buildXlsx } from '../src/services/xlsx.js';
import { ageOn, assignDetails, birthDate, heightCm, ignoreDetails, importSailorDetails, unmatchedDetails } from '../src/services/sailorDetails.js';
import { listSailors } from '../src/services/sailors.js';

describe('sailor age and height', () => {
  it('reads dates and heights the way the squad sheets write them', () => {
    expect(birthDate('33289')).toBe('1991-02-20');
    expect(birthDate('1991-02-20 00:00:00')).toBe('1991-02-20');
    expect(birthDate('02/20/1991')).toBe('1991-02-20');
    expect(birthDate('20/02/1991')).toBe('1991-02-20');
    expect(birthDate('2/7/01')).toBe('2001-02-07');
    expect(birthDate('x')).toBe('');
    expect(heightCm('1.85')).toBe(185);
    expect(heightCm('1,78 m')).toBe(178);
    expect(heightCm('190 cm')).toBe(190);
    expect(heightCm('85')).toBe(null);
    expect(ageOn('1991-02-20', '2026-11-21')).toBe(35);
    expect(ageOn('1991-11-22', '2026-11-21')).toBe(34);
  });

  it('a squad form (country above the table) and a combined sheet: matched by team and name; only the age goes out', () => {
    const s = setup();
    const mex = seedTeam(s.db, 'MEX', ['Ana Test', 'Bruno Sample', 'Clara Exámple']);
    seedTeam(s.db, 'POR', ['Joao Probe']);
    seedTeam(s.db, 'KOR', ['Min Demo']);
    s.db.prepare("UPDATE teams SET name = 'Mexico' WHERE code = 'MEX'").run();
    const form = [
      ',,,COUNTRY :  MEXICO',
      '',
      ',,,ATHLETES FAMILY NAME,FIRSTNAME ,GENDER (M/F),Date of Birth (M/D/Year),HEIGHT (in meter)',
      'Team Squad,,1,Test ,Ana,F,02/20/1991,"1,85"',
      ',,2,Sample,Bruno,M,03/15/1985,1.80',
      ',,3,Example,Clara,F,07/01/1997,1.66',
      ',,4,Someone,Coach,M,01/01/1970,1.75',
      ',,,Please upload your passport copy,,,,',
    ].join('\n');
    const r = importSailorDetails(s.db, Buffer.from(form), 'squad.csv');
    expect(r).toMatchObject({ rows: 4, matched: 3, updated: 3, teams: ['MEX'], unmatched: ['MEX Coach Someone'] });
    const crew = listSailors(s.ctx, mex.teamId);
    const ana = crew.find((x) => x.firstName === 'Ana')!;
    expect(ana.heightCm).toBe(185);
    expect(ana.age).toBeGreaterThanOrEqual(34);
    expect(JSON.stringify(crew)).not.toContain('1991');

    const xlsx = buildXlsx([{ name: 'Sailors', rows: [
      { Code: 'POR', Country: 'Portugal', 'Family name': 'Probe', 'First name': 'Joao', 'Date of birth': '2000-05-01', 'Height (cm)': '181' },
      { Code: 'XXX', Country: 'Nowhere', 'Family name': 'A', 'First name': 'B', 'Date of birth': '2000-05-01', 'Height (cm)': '181' },
    ] }]);
    const r2 = importSailorDetails(s.db, xlsx, 'sailors_age_height.xlsx');
    expect(r2).toMatchObject({ matched: 1, teams: ['POR'], unknownTeams: ['XXX'] });
    const r3 = importSailorDetails(s.db, Buffer.from(',,,COUNTRY : REPUBLIC OF KOREA\n,,,ATHLETES FAMILY NAME,FIRSTNAME,Date of Birth,HEIGHT\n,,1,DEMO,Min,03/04/1999,178'), 'kor.csv');
    expect(r3).toMatchObject({ matched: 1, teams: ['KOR'] });
  });

  it('unmatched rows: matched by hand (remembered on the next import) or ignored', () => {
    const s = setup();
    const t = seedTeam(s.db, 'MEX', ['Ana Test', 'Bruno Sample']);
    const sheet = [',,,COUNTRY : MEX', ',,,FAMILY NAME,FIRST NAME,Date of Birth,HEIGHT',
      ',,1,Test-Probe,Anita,02/20/1991,1.70', ',,2,Coach,Some,01/01/1970,1.80'].join('\n');
    const r = importSailorDetails(s.db, Buffer.from(sheet), 'a.csv');
    expect(r.matched).toBe(0);
    let open = unmatchedDetails(s.db, '2026-11-21');
    expect(open.map((x) => x.last)).toEqual(['Coach', 'Test-Probe']);
    expect(open[1]).toMatchObject({ team: 'MEX', age: 35, heightCm: 170 });
    expect(open[1].sailors.map((x) => x.name)).toEqual(['Bruno Sample', 'Ana Test']);
    expect(JSON.stringify(open)).not.toContain('1991');
    assignDetails(s.db, open[1].id, t.sailorIds[0]);
    ignoreDetails(s.db, open[0].id);
    expect(unmatchedDetails(s.db, '2026-11-21')).toEqual([]);
    expect(listSailors(s.ctx, t.teamId).find((x) => x.firstName === 'Ana')!.heightCm).toBe(170);
    // the next import: Anita goes to Ana again (new height), the coach stays ignored
    const r2 = importSailorDetails(s.db, Buffer.from(sheet.replace('1.70', '1.72')), 'a.csv');
    expect(r2).toMatchObject({ matched: 1, unmatched: [] });
    expect(listSailors(s.ctx, t.teamId).find((x) => x.firstName === 'Ana')!.heightCm).toBe(172);
    expect(unmatchedDetails(s.db, '2026-11-21')).toEqual([]);
  });
});
