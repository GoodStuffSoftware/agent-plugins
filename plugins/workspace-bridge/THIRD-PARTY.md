# Third-party code

## gmail-mcp (MIT)

- Upstream: https://github.com/mkpoli/gmail-mcp
- Commit: `9aa1b1a3baed8508adfc66c036ae7d019deff5c6`
- Licence: MIT
- Used in: `server/src/core/mime.ts`, adapted from `src/gmail.ts` at that commit (the RFC 5322 and
  RFC 2047 header encoding and folding, the multipart builder, the address and reply helpers, the
  quoting helpers, and the Gmail payload body readers).

Changes from upstream: errors are this server's `ToolError`, recipients are lists, a message may
have no recipient (drafts), body text is normalised to CRLF, and attachment and inline image
builders are left out for now.

```
MIT License

Copyright (c) 2026 mkpoli

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
