# Gmail Job Application Importer — High-Level Function Overview

## Overall Purpose

This file takes job-application emails from Gmail and turns them into job-tracker records.

The overall pipeline is:

Gmail emails
    ↓
Find relevant emails
    ↓
Clean the email subject
    ↓
Extract job title + company//from the subject or email 
    ↓
Find the job/application URL, list of ursl, then keywords from them 
    ↓
Determine application status
    ↓
Create a local parsed result
    ↓
Optionally ask AI to improve the result
    ↓
Save/update the job in Tracker
    ↓
Remember the email ID so it is not imported again


---

## 1. cleanSubject(subject)

### Purpose

Cleans unnecessary boilerplate from the beginning and end of an email subject.

### Example

Input:

    "Re: Fwd: Application received: Your application for Backend Engineer at Acme"

Output:

    "Backend Engineer at Acme"

### What it removes

- Re:
- Fwd:
- External/automated markers
- "Application received"
- "Your application for"
- "Thank you for applying"
- Interview boilerplate
- Other known application-email prefixes/suffixes

### Important idea

It can run multiple cleaning passes because prefixes can be stacked.

Example:

    "Re: Fwd: Application received: Your application for Backend Engineer"

    ↓

    "Fwd: Application received: Your application for Backend Engineer"

    ↓

    "Application received: Your application for Backend Engineer"

    ↓

    "Your application for Backend Engineer"

    ↓

    "Backend Engineer"

### Simple mental model

    Messy email subject
          ↓
    Remove known junk
          ↓
    Clean job-related text


---

## 2. splitRoleCompany(text)

### Purpose

Tries to split a piece of text into:

    title
    company

### It understands common formats

    "Backend Engineer at Google"

    ↓

    title   = "Backend Engineer"
    company = "Google"


    "Backend Engineer - Google"

    ↓

    title   = "Backend Engineer"
    company = "Google"


    "Backend Engineer: Google"

    ↓

    title   = "Backend Engineer"
    company = "Google"

### If it cannot find a company

Input:

    "Backend Engineer"

Output:

    title   = "Backend Engineer"
    company = ""

### Simple mental model

    "JOB TITLE at COMPANY"
              ↓
        Split into two


---

## 3. cleanTail(value)

### Purpose

Performs final cleanup on a title or company name.

### Example

    "Acme Corp | Bengaluru"

    ↓

    "Acme Corp"


    "Acme Corp (Remote)"

    ↓

    "Acme Corp"


    "Backend Engineer, Mumbai"

    ↓

    "Backend Engineer"

### It removes things such as

- Locations
- Remote/Hybrid/Onsite
- Full-time/Contract
- Separators and unnecessary spaces

### Simple mental model

    Partially-cleaned title/company
              ↓
        Remove extra metadata
              ↓
        Clean title/company


---

## 4. companyFromSender(from)

### Purpose

Tries to determine the employer from the email sender.

This is useful when the email subject does NOT contain the company name.

### Example

    From:
    "Acme Careers <jobs@acme.com>"

    ↓

    company = "Acme"


### Another example

    From:
    "no-reply@greenhouse.io"

    ↓

    company = "Greenhouse"

### Why this is useful

Sometimes the subject looks like:

    "Application Received - Requisition 88123"

There is no useful company name in the subject.

But the sender may reveal it:

    "Acme Careers"

So the sender becomes another source of company information.

### Simple mental model

    Email sender
         ↓
    Try to identify employer
         ↓
    Company name


---

## 5. pickJobUrl(links)

### Purpose

Looks through all links in an email and chooses the link most likely to be the actual job posting or application-status page.

### Example

Email contains:

    Unsubscribe
    Privacy Policy
    Facebook
    View Application
    View Job

The function tries to select:

    View Application → https://acme.com/jobs/123

instead of:

    Unsubscribe → https://acme.com/unsubscribe

### Why ranking is used

An email can contain many URLs.

The function gives higher priority to URLs that look like:

- Job pages
- Career pages
- Application pages
- Status pages
- ATS pages

### Simple mental model

    All email links
          ↓
    Remove obvious junk links
          ↓
    Score remaining links
          ↓
    Pick highest-scoring job link


---

## 6. inferStatus(message)

### Purpose

Determines the current application stage from the email.

Possible results include:

    applied
    interview
    offer
    rejected

### Examples

    "Thank you for applying..."

    ↓

    applied


    "We would like to invite you to an interview..."

    ↓

    interview


    "Unfortunately, we will not be moving forward..."

    ↓

    rejected


    "We are pleased to offer you..."

    ↓

    offer

### Important idea

It looks at the email subject + snippet/body and searches for known status signals.

### Simple mental model

    Email content
         ↓
    Look for outcome language
         ↓
    Application stage


---

## 7. looksLikeApplicationMail(message)

### Purpose

Answers:

    "Is this email actually related to a job application?"

This is different from inferStatus().

### Example

    "Thank you for applying to Backend Engineer"

    ↓

    true


    "Your application has been received"

    ↓

    true


    "50% off our Black Friday sale"

    ↓

    false

### Why it exists

The normal Gmail search query already filters emails.

But the "full scan" reads a much larger window of emails.

Therefore, the code needs another filter to prevent unrelated emails from becoming job cards.

### Simple mental model

    Is this an application email?
          ↓
       YES / NO


---

## 8. parseLocally(message)

### Purpose

This is the main LOCAL parsing pipeline.

It combines several of the previous functions.

### What it does

    Email
      ↓
    cleanSubject()
      ↓
    splitRoleCompany()
      ↓
    companyFromSender()
      ↓
    pickJobUrl()
      ↓
    inferStatus()
      ↓
    Local result

### Example

Input:

    Subject:
    "Re: Your application for Backend Engineer at Acme"

    Sender:
    "Acme Careers"

    Link:
    "https://acme.com/jobs/123"

    Body:
    "Thank you for applying..."

Output:

    {
        title: "Backend Engineer",
        company: "Acme",
        url: "https://acme.com/jobs/123",
        status: "applied"
    }

### Simple mental model

    Email
      ↓
    Local parser
      ↓
    title
    company
    url
    status


---

# AI ENRICHMENT


## 9. parseJsonObject(text)

### Purpose

Safely extracts a JSON object from an AI response.

### Problem

The AI may be asked to return:

    {
        "title": "Backend Engineer",
        "company": "Acme"
    }

But AI might actually respond with:

    Sure! Here's the JSON:

    {
        "title": "Backend Engineer",
        "company": "Acme"
    }

Or put the JSON inside a code block.

This function searches the response for a valid JSON object and parses it.

### Simple mental model

    Messy AI response
          ↓
    Find JSON object
          ↓
    JSON.parse()
          ↓
    JavaScript object


---

## 10. buildExtractionPrompt(message, local)

### Purpose

Builds the instructions that will be sent to the AI.

It gives the AI:

    Email subject
    Sender
    Sender domain
    First part of email body
    Local parser's result

Then asks the AI to return:

    title
    company
    url
    stage

### Important idea

This function DOES NOT call the AI.

It only builds the prompt.

### Simple mental model

    Email
      +
    Local parser result
      +
    Extraction rules
      ↓
    AI prompt


---

## 11. enrichWithAi(message, local, settings)

### Purpose

Uses the configured AI provider to improve the local parser's result.

### Example

Local parser:

    {
        title: "DEEP-DIVE",
        company: "Talent Acquisition Team",
        url: "",
        status: "applied"
    }

AI sees more context from the email and may produce:

    {
        title: "Backend Engineer",
        company: "Acme",
        url: "https://acme.com/jobs/88123",
        status: "applied"
    }

### Important fallback behavior

If AI is unavailable or fails:

    AI fails
       ↓
    Keep local result

The import does NOT depend on AI working.

### Simple mental model

    Local result
         ↓
       AI
         ↓
    Improved result

    If AI fails:
         ↓
    Keep local result


---

# EMAIL DUPLICATE PREVENTION


## 12. EmailLedger.read()

### Purpose

Reads the list of Gmail message IDs that have already been imported.

### Example

    [
        "gmail-message-123",
        "gmail-message-456",
        "gmail-message-789"
    ]

### Why

Prevents the same email from being imported repeatedly.

### Simple mental model

    Storage
       ↓
    Read imported email IDs


---

## 13. EmailLedger.write(ids)

### Purpose

Saves the updated list of imported Gmail message IDs.

It also limits the ledger size so it doesn't grow forever.

### Simple mental model

    Imported IDs
         ↓
    Limit size
         ↓
    Save to storage


---

## 14. EmailLedger.clear()

### Purpose

Deletes the imported-email ledger.

### Simple mental model

    Delete history of imported email IDs


---

# SYNC / UTILITY FUNCTIONS


## 15. tidyField(value, maxLength)

### Purpose

Final cleanup for text before storing/sending it.

### Example

    "   Senior     Backend     Engineer   "

    ↓

    "Senior Backend Engineer"

It also limits the maximum length.

### Simple mental model

    Raw text
      ↓
    Normalize spaces
      ↓
    Trim
      ↓
    Limit length
      ↓
    Clean field


---

## 16. buildQuery(settings)

### Purpose

Builds the normal Gmail search query.

### Example

User settings:

    Query:
    "application received"

    Lookback:
    30 days

Result:

    "application received newer_than:30d"

### Simple mental model

    User's Gmail search
           +
    Date limit
           ↓
    Final Gmail query


---

## 17. buildWindowQuery(settings)

### Purpose

Creates the query used for a FULL inbox/window scan.

Instead of searching only for specific application phrases, it basically says:

    Give me everything from the last N days.

Then:

    looksLikeApplicationMail()

decides which messages are actually relevant.

### Simple mental model

    Last 30 days of email
           ↓
    Fetch broadly
           ↓
    Application relevance filter


---

## 18. messageReceivedAt(message)

### Purpose

Gets the actual timestamp of the email.

### Why

The application date should come from the email itself, not from the moment the sync happened.

### Example

Email arrived:

    October 5

Sync runs:

    October 9

The application should be recorded as:

    October 5

not:

    October 9

### Simple mental model

    Email
      ↓
    Find actual received date
      ↓
    Timestamp


---

## 19. mapWithConcurrency(items, limit, worker)

### Purpose

Processes many items without running too many operations at once.

### Example

Instead of:

    25 emails
       ↓
    25 requests simultaneously

it can do:

    4 requests
       ↓
    next 4
       ↓
    next 4
       ↓
    ...

### Why

Prevents excessive simultaneous Gmail/API requests and reduces rate-limit problems.

### Simple mental model

    Many tasks
       ↓
    Limit simultaneous tasks
       ↓
    Process everything safely


---

## 20. readSyncState()

### Purpose

Reads the result/status of the previous sync.

### Example

    {
        ok: true,
        scanned: 25,
        added: 4,
        updated: 2,
        failed: 1
    }

### Simple mental model

    Storage
       ↓
    Read previous sync report


---

## 21. writeSyncState(state)

### Purpose

Saves the current sync report/state.

### Simple mental model

    Current sync result
          ↓
    Save to storage


---

# MAIN ORCHESTRATOR


## 22. runSync()

### Purpose

This is the MAIN function of the entire file.

It coordinates the complete Gmail → Job Tracker workflow.

### High-level flow

    runSync()
       │
       ├── Check settings
       │
       ├── Check Gmail connection
       │
       ├── Build Gmail query
       │
       ├── Find email IDs
       │
       ├── Fetch emails
       │
       ├── Check duplicate/imported emails
       │
       ├── Check application relevance
       │
       ├── parseLocally()
       │
       ├── enrichWithAi() if enabled
       │
       ├── Build job record
       │
       ├── Check if job already exists
       │
       ├── Add/update Tracker
       │
       ├── Update EmailLedger
       │
       └── Save sync report

### Example

Gmail contains:

    "Thank you for applying to Backend Engineer at Acme"

runSync() eventually creates something like:

    {
        title: "Backend Engineer",
        company: "Acme",
        url: "https://acme.com/jobs/123",
        status: "applied",
        sourceEmailId: "gmail-message-id",
        emailAt: <email date>
    }

and saves it into the Tracker.

### Simple mental model

    runSync()
        =
    "Run the entire email-import system."


---

# SETTINGS


## 23. loadSettings()

### Purpose

Loads the extension's settings.

It combines:

    Bundled/default settings
             +
    User's saved settings
             ↓
       Final settings

### Example

Default:

    emailLookbackDays = 30

User setting:

    emailLookbackDays = 60

Final:

    emailLookbackDays = 60

### Simple mental model

    Default configuration
           +
    User overrides
           ↓
    Actual configuration used by the app


---

# BIG-PICTURE FUNCTION RELATIONSHIP


The important functions can be grouped into layers.


## Layer 1 — Find the right emails

    buildQuery()
    buildWindowQuery()
    looksLikeApplicationMail()


## Layer 2 — Understand the email

    cleanSubject()
    splitRoleCompany()
    cleanTail()
    companyFromSender()
    pickJobUrl()
    inferStatus()


## Layer 3 — Produce structured data

    parseLocally()


## Layer 4 — Improve with AI

    buildExtractionPrompt()
    enrichWithAi()
    parseJsonObject()


## Layer 5 — Prevent duplicates

    EmailLedger.read()
    EmailLedger.write()
    EmailLedger.clear()


## Layer 6 — Sync utilities

    tidyField()
    messageReceivedAt()
    mapWithConcurrency()
    readSyncState()
    writeSyncState()


## Layer 7 — Orchestration

    runSync()


## Layer 8 — Configuration

    loadSettings()


---

# THE MOST IMPORTANT FLOW TO REMEMBER


    Gmail Email
        │
        ▼
    runSync()
        │
        ▼
    Is it already imported?
        │
        ▼
    Is it an application email?
        │
        ▼
    parseLocally()
        │
        ├── cleanSubject()
        │
        ├── splitRoleCompany()
        │
        ├── companyFromSender()
        │
        ├── pickJobUrl()
        │
        └── inferStatus()
        │
        ▼
    Local structured result
        │
        ▼
    AI enabled?
        │
        ├── NO ────────────────┐
        │                      │
        └── YES → enrichWithAi │
                               │
                               ▼
                        Final job data
                               │
                               ▼
                         Tracker.save()
                               │
                               ▼
                        EmailLedger.write()
                               │
                               ▼
                          Sync complete


---

# ONE-LINE CHEAT SHEET


cleanSubject()
→ Remove junk from subject.


splitRoleCompany()
→ Separate job title and company.


cleanTail()
→ Remove location/work-type junk from the end.


companyFromSender()
→ Guess the company from the sender.


pickJobUrl()
→ Find the most likely job/application URL.


inferStatus()
→ Decide Applied / Interview / Offer / Rejected.


looksLikeApplicationMail()
→ Decide whether the email is actually job-related.


parseLocally()
→ Run all local extraction logic and produce structured job data.


parseJsonObject()
→ Extract valid JSON from an AI response.


buildExtractionPrompt()
→ Build the instructions sent to the AI.


enrichWithAi()
→ Ask AI to improve/correct the local extraction.


EmailLedger.read()
→ Get already-imported email IDs.


EmailLedger.write()
→ Save imported email IDs.


EmailLedger.clear()
→ Clear the imported-email history.


tidyField()
→ Normalize and shorten text.


buildQuery()
→ Build the normal Gmail search query.


buildWindowQuery()
→ Build the broad full-scan Gmail query.


messageReceivedAt()
→ Get the email's actual timestamp.


mapWithConcurrency()
→ Process multiple emails with a controlled number of simultaneous operations.


readSyncState()
→ Read the previous sync result.


writeSyncState()
→ Save the current sync result.


runSync()
→ Orchestrate the entire Gmail → Tracker import.


loadSettings()
→ Load default + user settings.