package git

import (
	"github.com/go-git/go-git/v5/plumbing/transport/http"
)

type Credentials struct {
	Username string
	Token    string
	RepoURL  string
	Branch   string
}

func (c *Credentials) Auth() *http.BasicAuth {
	if c.Username == "" && c.Token == "" {
		return nil
	}
	return &http.BasicAuth{
		Username: c.Username,
		Password: c.Token,
	}
}
