# Document editing

Engramer Store edits documents without giving the server plaintext. This page explains the design, what ships today, and where collaborative editing is headed.

## The constraint

Self-hosted office suites in the Nextcloud mold (Collabora Online, OnlyOffice Document Server) integrate over WOPI: the storage app hands the document to a suite server, which renders and processes it server-side. That architecture requires plaintext on the server, which is why Nextcloud's own end-to-end encrypted folders cannot be opened by those integrations. Bolting a WOPI suite onto Engramer Store would quietly delete its core guarantee.

The constraint is not a dead end. CryptPad ships collaborative documents where the server is a blind relay that stores and orders encrypted patches it cannot read, with all merging done client-side, and Proton Docs delivers Google-Docs-style live co-editing (cursors, presence, comments) fully end-to-end encrypted. Editing under E2EE is a solved product category; it just has to run on the client.

## What ships today

An in-app editor for text, Markdown, and code:

- Open any text file and press Edit, or create a fresh note with "New note" (also in the command palette). Notes are ordinary Markdown files.
- Content decrypts into the editor in your browser, and re-encrypts with the file's existing key on save (Cmd+S). The replaced blob and refreshed metadata (size, modification time, search text) are all the server ever sees, as ciphertext.
- Saved edits are immediately searchable, because the search index lives in the encrypted metadata and is rebuilt from the new content at save time.

## Roadmap: live collaboration

The collaborative layer follows the architecture CryptPad proved and secsync documents for Yjs:

1. **CRDT documents.** Notes become Yjs documents edited through a rich-text editor component. CRDTs merge concurrent edits deterministically on the client, so the server never needs to understand content to resolve conflicts.
2. **Encrypted relay.** The server gains one deliberately dumb endpoint: an ordered, append-only channel per document over WebSocket. Clients encrypt every Yjs update with the file key before sending; the relay stores and broadcasts opaque bytes in arrival order. Presence and cursors travel as encrypted ephemeral messages on the same channel.
3. **Snapshots.** Clients periodically write an encrypted snapshot (the compacted document state) so new participants load one blob plus a short update tail instead of full history. Snapshots use the existing blob store.
4. **Sharing.** A collaborator needs the channel id (server-visible) and the file key (shared via the existing mechanisms: sealed box to an account's public key, or a link fragment). The relay learns who connects to which channel and how much they send, and nothing else.

Format ambitions are deliberately sequenced: Markdown and rich text first, which is the fidelity envelope Proton Docs launched with; DOCX import and export through client-side conversion next; spreadsheets after that, a step Proton Sheets has since shown is also achievable under end-to-end encryption with native XLSX import and export. Full-fidelity presentation (PPTX) editing is the one capability that so far remains with server-side suites, and any future integration of one would be an explicitly labeled opt-in that marks affected files as not end-to-end encrypted, never a silent default.

## References

- CryptPad developer documentation (ChainPad, history keeper): https://docs.cryptpad.org/en/dev_guide/general.html
- CryptPad Document app (client-side OnlyOffice integration): https://docs.cryptpad.org/en/user_guide/apps/document.html
- Proton Docs announcement (E2EE real-time collaboration): https://proton.me/blog/docs-proton-drive
- Proton Sheets format support (E2EE spreadsheet editing with XLSX): https://proton.me/support/sheets-import-export
- secsync, an architecture for E2EE CRDTs with a Yjs reference implementation: https://github.com/serenity-kit/secsync
- Peritext, a CRDT for rich text: https://www.inkandswitch.com/peritext/
- Nextcloud Office configuration (WOPI-based integration): https://docs.nextcloud.com/server/stable/admin_manual/office/configuration.html
