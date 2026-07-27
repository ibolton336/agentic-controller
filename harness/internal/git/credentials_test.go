package git

import "testing"

func TestAuthReturnsNilForEmptyCreds(t *testing.T) {
	c := &Credentials{}
	if c.Auth() != nil {
		t.Error("Auth() should return nil when both Username and Token are empty")
	}
}

func TestAuthReturnsBasicAuthWithCreds(t *testing.T) {
	c := &Credentials{Username: "user", Token: "token"}
	auth := c.Auth()
	if auth == nil {
		t.Fatal("Auth() should return non-nil BasicAuth")
	}
	if auth.Username != "user" {
		t.Errorf("Username = %q, want %q", auth.Username, "user")
	}
	if auth.Password != "token" {
		t.Errorf("Password = %q, want %q", auth.Password, "token")
	}
}

func TestAuthReturnsBasicAuthWithTokenOnly(t *testing.T) {
	c := &Credentials{Token: "token"}
	auth := c.Auth()
	if auth == nil {
		t.Fatal("Auth() should return non-nil when Token is set")
	}
}
