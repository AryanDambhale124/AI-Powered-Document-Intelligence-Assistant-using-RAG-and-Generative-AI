export type DocStatus = "uploaded" | "processing" | "ready" | "error";

export interface DocItem {
  id: string;
  filename: string;
  status: DocStatus;
  pageCount?: number;
  chunkCount?: number;
  error?: string;
}

export interface Citation {
  documentId: string;
  filename: string;
  pageNumber: number;
  excerpt: string;
}

export interface Message {
  id: string;
  role: "user" | "assistant";
  content: string;
  citations: Citation[];
  error?: boolean;
}

export interface ChatItem {
  id: string;
  title: string;
  documentIds: string[];
}

export const SAMPLE_TEXT = `DocuMind AI Sample: Acme Robotics Employee Handbook

Section 1 - Leave Policy. Full-time employees receive 24 days of paid annual leave per calendar year. Unused leave up to 5 days may be carried over into the next year. Sick leave is separate and provides 12 paid days per year; a medical certificate is required for absences longer than 3 consecutive days.

Section 2 - Remote Work. Employees may work remotely up to 3 days per week with manager approval. Core collaboration hours are 11:00 to 15:00 local time. Equipment such as a laptop and monitor is provided by the company; a home-office stipend of 500 USD is available once every two years.

Section 3 - Expenses. Travel must be booked through the approved portal. Meals during business travel are reimbursed up to 60 USD per day. Expense reports must be submitted within 30 days of the purchase date.

Section 4 - Security. All laptops must use full-disk encryption. Passwords must be at least 14 characters and multi-factor authentication is mandatory for all company systems. Security incidents must be reported to the security team within 2 hours.`;

export const SUGGESTIONS = [
  "Summarize the key points of this document",
  "What are the most important dates or numbers?",
  "List any rules, requirements or action items",
];
