/** A crew member as published by the source. */
export interface ParsedMember {
  sourceName: string;
  number: string | null;
  position: string | null;
  /** Declared weight in kg as published (e.g. "67.00"), when the source has it. */
  weight?: string | null;
  /** Stable person id from the source, when the source has one. */
  sourceId: string | null;
}

export interface ParsedDeclaration {
  /** Team as written by the source (code or name); matched to teams by code, then aliases. */
  teamRef: string;
  /** Sailing day the crew is declared for, YYYY-MM-DD. Never the fetch date. */
  date: string;
  dateRaw: string;
  postedRaw: string | null;
  sourceRef: string | null;
  /** The source's own crew total in kg, when published. */
  totalWeight?: string | null;
  members: ParsedMember[];
}

export interface ParseResult { declarations: ParsedDeclaration[]; warnings: string[] }

export interface ParseContext {
  /** Year used to complete dates published without a year. */
  year: number;
  /** Used to resolve relative links; empty when unknown (e.g. demo file). */
  baseUrl: string;
}

export class ParseError extends Error {}

export interface Importer {
  id: string;
  label: string;
  description: string;
  parse(body: string, ctx: ParseContext): ParseResult;
}
