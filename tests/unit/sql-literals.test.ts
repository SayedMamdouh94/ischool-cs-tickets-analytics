import { describe, expect, it } from "vitest";
import { dollarQuote, firstJsonObject, inlineParams, jsonLiteral, sqlLiteral } from "../../scripts/lib/db";

/** Extracts the body of a dollar-quoted literal produced by dollarQuote(). */
function body(literal: string): { tag: string; content: string } {
  const m = /^\$(q[0-9a-f]+)\$([\s\S]*)\$\1\$(::jsonb)?$/.exec(literal);
  if (!m) throw new Error(`not a dollar-quoted literal: ${literal.slice(0, 40)}`);
  return { tag: m[1], content: m[2] };
}

describe("SQL literal encoding (passwordless transport)", () => {
  it("dollar-quotes text with a tag that never occurs inside it", () => {
    const hostile = "x'); drop table public.tickets; --$q$ $$ $q1$ ' \" \\ غياب\n";
    const lit = dollarQuote(hostile);
    const { tag, content } = body(lit);
    expect(content).toBe(hostile);
    expect(hostile.includes(`$${tag}$`)).toBe(false);
  });

  it("encodes scalars, nulls, dates and JSON safely", () => {
    expect(sqlLiteral(null)).toBe("NULL");
    expect(sqlLiteral(undefined)).toBe("NULL");
    expect(sqlLiteral(true)).toBe("TRUE");
    expect(sqlLiteral(42)).toBe("42");
    expect(sqlLiteral(-1.5)).toBe("-1.5");
    expect(() => sqlLiteral(Number.NaN)).toThrow();
    expect(body(sqlLiteral(new Date("2026-04-14T14:56:23Z"))).content).toBe("2026-04-14T14:56:23.000Z");
    expect(JSON.parse(body(sqlLiteral({ a: "مرحبا" })).content)).toEqual({ a: "مرحبا" });
    expect(JSON.parse(body(jsonLiteral([{ note: "line1\nline2 $x$" }])).content)).toEqual([{ note: "line1\nline2 $x$" }]);
  });

  it("substitutes placeholders in one pass without rescanning inserted text", () => {
    const sql = inlineParams("select $1::text as a, $2::int as b, $10x", ["$2 should stay literal", 7]);
    expect(sql).toMatch(/^select \$q[0-9a-f]+\$\$2 should stay literal\$q[0-9a-f]+\$::text as a, 7::int as b, \$10x$/);
  });

  it("rejects missing parameters", () => {
    expect(() => inlineParams("select $1, $2", ["only one"])).toThrow(/\$2/);
  });

  it("extracts the first JSON object from noisy CLI output", () => {
    const out = 'Initialising login role...\n{"rows":[{"a":"}{ \\" brace"}],"warning":"x"}\nA new version of Supabase CLI is available {not json}';
    expect(JSON.parse(firstJsonObject(out)!)).toEqual({ rows: [{ a: '}{ " brace' }], warning: "x" });
    expect(firstJsonObject("no json here")).toBeNull();
  });
});

describe("atomic scripts", () => {
  it("wraps statements in a DO block whose tag does not occur inside", async () => {
    const { atomicBlock } = await import("../../scripts/lib/db");
    const inner = "insert into t select 1; update t set a = 2;";
    const block = atomicBlock(inner);
    const m = /^do \$(do_[0-9a-f]+)\$\nbegin\n([\s\S]*)\nend\n\$\1\$;$/.exec(block);
    expect(m).not.toBeNull();
    expect(m![2]).toBe(inner);
    expect(inner.includes(m![1])).toBe(false);
  });
});
