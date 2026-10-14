import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { categoryForTopic, classifyTicket, detectTheme, normalizeForMatching, THEME_RULES } from "@/lib/classification/rules";
import { DEFAULT_PROJECTS } from "@/lib/ingest/default-projects";

const mappings = [
  { code: "general_inquiry", sourceTopics: ["Report a Problem / inquiry"] },
  { code: "attendance_appeals", sourceTopics: ["Virtual Session Absence Appeal"] },
];

describe("normalizeForMatching", () => {
  it("normalizes Arabic letter variants, diacritics, tatweel and digits", () => {
    expect(normalizeForMatching("أُريد تقييمـــاً لدرجةٍ ٣٥")).toBe("اريد تقييما لدرجه 35");
    expect(normalizeForMatching("QUIZ")).toBe("quiz");
  });
});

describe("detectTheme", () => {
  it("classifies attendance complaints in Arabic and English", () => {
    expect(detectTheme("انا كنت حاضر ومكتوب غياب").subcategory).toBe("attendance_records");
    expect(detectTheme("I was marked absent although I attended").subcategory).toBe("attendance_records");
  });

  it("does not treat the polite form حضرتك as attendance", () => {
    expect(detectTheme("ممكن حضرتك تساعدني").subcategory).toBe("unmatched");
  });

  it("does not confuse النتيجه (result) with النت (internet)", () => {
    expect(detectTheme("فين النتيجه").subcategory).not.toBe("connectivity_media");
    expect(detectTheme("النت فصل في الجلسة").subcategory).toBe("connectivity_media");
  });

  it("returns structured / unmatched buckets honestly", () => {
    expect(detectTheme(null)).toMatchObject({ subcategory: "no_free_text", confidence: 1 });
    expect(detectTheme("wwwwg")).toMatchObject({ subcategory: "unmatched", confidence: null });
  });

  it("reports evidence as rule labels, never message text", () => {
    const r = detectTheme("الامتحان والكويز مش بيفتحوا");
    expect(r.subcategory).toBe("quizzes_exams");
    expect(r.matchedTerms.every((t) => t.length < 20)).toBe(true);
    expect(r.confidence).toBeGreaterThan(0.5);
  });

  it("has unique theme codes", () => {
    const codes = THEME_RULES.map((r) => r.code);
    expect(new Set(codes).size).toBe(codes.length);
  });
});

describe("classifyTicket", () => {
  it("maps the topic to a category and keeps unknown topics uncategorized", () => {
    expect(categoryForTopic("Report a Problem / inquiry", mappings)).toBe("general_inquiry");
    expect(categoryForTopic("Something New", mappings)).toBe("uncategorized");
    const c = classifyTicket("Virtual Session Absence Appeal", "اتسجلت غياب", mappings);
    expect(c).toMatchObject({ categoryCode: "attendance_appeals", subcategoryCode: "attendance_records" });
    expect(c.evidence.topic_mapped).toBe(true);
  });
});

describe("reference data stays in sync with migrations", () => {
  const sql = readFileSync(path.resolve(__dirname, "../../supabase/migrations/20261014090200_reference_data.sql"), "utf8");

  it("offline project list mirrors the seeded projects", () => {
    for (const p of DEFAULT_PROJECTS) {
      expect(sql).toContain(`'${p.code}'`);
      expect(sql).toContain(`${p.organization_id}, '${p.file_name_hint}'`);
    }
  });

  it("every theme code has a subcategory row", () => {
    for (const r of THEME_RULES) expect(sql).toContain(`('${r.code}',`);
    expect(sql).toContain("('no_free_text',");
    expect(sql).toContain("('unmatched',");
  });
});
