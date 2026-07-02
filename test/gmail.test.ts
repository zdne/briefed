import { describe, expect, it } from "vitest";
import {
  buildGmailQuery,
  gmailSourceKey,
  messageInternalDate,
  normalizeGmailMessage,
  type GmailMessage
} from "../src/gmail.js";

describe("buildGmailQuery", () => {
  it("adds an after filter when a cursor is supplied", () => {
    expect(buildGmailQuery("label:newsletters", "2026-07-01T12:00:00.000Z"))
      .toBe("label:newsletters after:1782907200");
  });
});

describe("normalizeGmailMessage", () => {
  it("normalizes a plain text Gmail message", () => {
    const message: GmailMessage = {
      id: "msg-1",
      threadId: "thread-1",
      internalDate: "1782907200000",
      snippet: "Snippet",
      payload: {
        headers: [
          { name: "Subject", value: "Newsletter subject" },
          { name: "From", value: "Writer <writer@example.com>" }
        ],
        parts: [
          {
            mimeType: "text/plain",
            body: { data: Buffer.from("Plain body").toString("base64url") }
          }
        ]
      }
    };

    expect(normalizeGmailMessage(message, "label:newsletters", "2026-07-01T13:00:00.000Z"))
      .toMatchObject({
        sourceKey: gmailSourceKey("label:newsletters"),
        sourceItemId: "msg-1",
        canonicalUrl: null,
        title: "Newsletter subject",
        author: "Writer <writer@example.com>",
        sourceSummary: "Snippet",
        contentText: "Plain body",
        publishedAt: "2026-07-01T12:00:00.000Z",
        collectedAt: "2026-07-01T13:00:00.000Z"
      });
  });

  it("falls back to HTML body conversion", () => {
    const message: GmailMessage = {
      id: "msg-2",
      internalDate: "1782907200000",
      payload: {
        headers: [{ name: "Subject", value: "HTML newsletter" }],
        parts: [
          {
            mimeType: "text/html",
            body: { data: Buffer.from("<p>Hello <b>HTML</b></p>").toString("base64url") }
          }
        ]
      }
    };

    expect(normalizeGmailMessage(message, "label:newsletters", "2026-07-01T13:00:00.000Z").contentText)
      .toBe("Hello HTML");
  });

  it("returns message internal date as ISO", () => {
    expect(messageInternalDate({ id: "msg", internalDate: "1782907200000" }))
      .toBe("2026-07-01T12:00:00.000Z");
  });
});
