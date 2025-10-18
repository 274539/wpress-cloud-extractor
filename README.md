# WPress Cloud Extractor (MVP)
- POST /extract (multipart "wpress") -> returns .zip stream
- Limit via MAX_UPLOAD_MB (default 1024)
- Uses /tmp for workspace; auto-cleans after request

Deploy on Render as a Web Service (Standard plan).
