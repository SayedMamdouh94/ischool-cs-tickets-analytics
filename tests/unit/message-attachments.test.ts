import { describe, expect, it } from "vitest";
import { detectLanguage, normalizeSubTopic, parseMessage } from "@/lib/ingest/message";
import { parseAttachmentField } from "@/lib/ingest/attachments";

describe("parseMessage", () => {
  it("extracts session fields and free-text details", () => {
    const m = parseMessage(
      "Session ID: 7474763, Lesson: Physical Session 5, Start: أربعاء ٢٦/٠٨/٢٠٢٦ ٠٩:٠٠ ص, End: ١١:٣٠ ص, Details: النت كان سئ جدا\nو المدرس مشانا بدري",
    );
    expect(m.structure).toBe("session");
    expect(m.sessionRef).toBe("7474763");
    expect(m.lessonName).toBe("Physical Session 5");
    expect(m.details).toBe("النت كان سئ جدا\nو المدرس مشانا بدري");
    expect(m.language).toBe("ar");
  });

  it("handles session messages without details", () => {
    const m = parseMessage("Session ID: 5859718, Lesson: مقدمة في تصور البيانات, Start: سبت ٩/٠٥/٢٠٢٦ ٠٤:٠٠ م, End: ٠٦:٣٠ م");
    expect(m.lessonName).toBe("مقدمة في تصور البيانات");
    expect(m.details).toBeNull();
    expect(m.language).toBe("none");
  });

  it("extracts the sub topic and multi-line details", () => {
    const m = parseMessage("Sub Topic: A problem or inquiry not related to the session currently in progress\nDetails: line one\nline two");
    expect(m.structure).toBe("sub_topic");
    expect(m.details).toBe("line one\nline two");
    expect(normalizeSubTopic(m.subTopic)).toBe("Not related to the session in progress");
    expect(normalizeSubTopic("مشكلة أو استفسار متعلق بالجلسة الجارية الآن")).toBe("Related to the session in progress");
  });

  it("recognises other structures without inventing details", () => {
    expect(parseMessage("Details: why can't the quiz open").structure).toBe("details");
    expect(parseMessage("Info Type: Registered phone number, Details: x").infoType).toBe("Registered phone number");
    expect(parseMessage("Slot: wednesday 01:00 PM").structure).toBe("logistics");
    expect(parseMessage("-").structure).toBe("placeholder");
    expect(parseMessage(null).structure).toBe("empty");
    expect(parseMessage("free text only").structure).toBe("unstructured");
  });

  it("detects language from letters", () => {
    expect(detectLanguage("hello there")).toBe("en");
    expect(detectLanguage("مرحبا بكم")).toBe("ar");
    expect(detectLanguage("الـ final project مش شغال")).toBe("mixed");
    expect(detectLanguage("12345")).toBe("none");
  });
});

describe("parseAttachmentField", () => {
  it("normalizes a single URL and decodes the file name", () => {
    const r = parseAttachmentField("https://api.ischooltech.com/blobs/x--y/Screenshot%202026-09-02.png?disposition=attachment", "request");
    expect(r.attachments).toHaveLength(1);
    expect(r.attachments[0]).toMatchObject({ host: "api.ischooltech.com", fileName: "Screenshot 2026-09-02.png", extension: "png", position: 1 });
  });

  it("splits several URLs and counts invalid tokens", () => {
    const r = parseAttachmentField("https://a.test/1.pdf, https://b.test/2.jpg\nnot-a-url javascript:alert(1)", "response");
    expect(r.attachments.map((a) => a.host)).toEqual(["a.test", "b.test"]);
    expect(r.attachments.every((a) => a.attachmentType === "response")).toBe(true);
    expect(r.invalidTokens).toBe(2);
  });

  it("returns nothing for blanks", () => {
    expect(parseAttachmentField("", "request").attachments).toEqual([]);
  });
});
