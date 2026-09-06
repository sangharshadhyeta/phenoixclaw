# Pushing this repo

The GitHub remote is authenticated by an SSH key on this host, not by a token.

    key         /root/.ssh/id_ed25519_solid   (comment: solid.cpp-push)
    fingerprint SHA256:IXhryfzB2jO7uBeh0Cf8hscQUgyq7j5fDvnOmyjhlEQ
    host alias  github-solid                  (see /root/.ssh/config)
    account     sangharshadhyeta
    remote      git@github-solid:sangharshadhyeta/phenoixclaw.git
    branch      phoenixclaw-main

To push:

    git push git@github-solid:sangharshadhyeta/phenoixclaw.git phoenixclaw-main

The repository keeps its old name on GitHub deliberately — only the UI says
"Phoenix". The npm workspace names (`pithagoras`, `@pithagoras/server`) and the
`pithagoras.channel` marker are a public contract and are not renamed either;
see CLAUDE.md.
