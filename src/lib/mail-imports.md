# Gmail Job Application Importer Reference

## Overview
A script/extension that automatically converts job application emails from Gmail into structured tracker records.

## Core Functions
* **`cleanSubject(subject)`**: Strips boilerplate (`Re:`, `Fwd:`, "Application received") from subjects to isolate job titles and companies.
* **`splitRoleCompany(text)`**: Splits cleaned strings (e.g., "Backend Engineer at Google") into `title` and `company` fields.
* **`cleanTail(value)`**: Removes trailing metadata (locations, remote/hybrid tags, employment type) from extracted titles or company names.
* **`companyFromSender(from)`**: Identifies the employer name from the sender address or display name when the subject lacks it.
* **`pickJobUrl(links)`**: Filters email links, removes junk (like unsubscribe URLs), and selects the highest-scoring job posting or status link.
* **`inferStatus(message)`**: Analyzes email content for outcome language to categorize stages as applied, interview, offer, or rejected.
* **`looksLikeApplicationMail(message)`**: Determines if an email is genuinely job-related during broad inbox scans.
* **`parseLocally(message)`**: Combines local extraction functions to produce a structured job record.

## AI Enrichment & Duplicate Prevention
* **`parseJsonObject(text)`**: Safely extracts and parses JSON objects from AI responses, stripping conversational filler or code blocks.
* **`buildExtractionPrompt(message, local)`**: Constructs prompts containing email details and local parser results for AI evaluation.
* **`enrichWithAi(message, local, settings)`**: Enhances local output using a configured AI provider, falling back to local results if it fails.
* **`EmailLedger`**: Reads, writes, and clears a stored list of processed Gmail message IDs to prevent duplicate imports.

## Utilities & Orchestration
* **`tidyField(value, maxLength)`**: Normalizes whitespace, trims text, and enforces character limits.
* **`buildQuery` / `buildWindowQuery`**: Formulates narrow application queries or broad date-range search strings for Gmail.
* **`messageReceivedAt(message)`**: Extracts the actual email timestamp so applications reflect when they arrived, not when synced.
* **`mapWithConcurrency(items, limit, worker)`**: Controls batch processing limits to prevent rate-limiting during simultaneous requests.
* **`readSyncState` / `writeSyncState`**: Manages storage and retrieval of sync reports summarizing recent results.
* **`runSync()`**: The main orchestrator coordinating the entire pipeline from Gmail querying and parsing to tracker saving and ledger updates.
* **`loadSettings()`**: Merges default configuration values with user-defined settings.


orchestrators:

parseLocally: very small ai function
enrichWithAi: 
runSync:





