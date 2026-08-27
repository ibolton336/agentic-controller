/*
Copyright 2026.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

package controller

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"time"

	"github.com/google/go-containerregistry/pkg/authn"
	"github.com/google/go-containerregistry/pkg/name"
	"github.com/google/go-containerregistry/pkg/v1/remote"
	"github.com/google/go-containerregistry/pkg/v1/remote/transport"
)

// imageResolution is the outcome of checking whether an image ref points at a
// real artifact. It has three states on purpose: "missing" and "unknown" are
// not the same thing, and only "missing" is a defect worth condemning a card
// for. An "unknown" result (the registry could not be reached, or refused the
// check without pull credentials the controller does not hold) must never flip
// a card out of readiness, because the pod may still be able to pull it.
type imageResolution int

const (
	// imageResolveUnknown means the check was inconclusive: a network error, a
	// timeout, or an auth challenge the controller could not answer. The image
	// might still be pullable by a pod that carries the right imagePullSecrets.
	imageResolveUnknown imageResolution = iota

	// imageResolvePresent means the registry served a manifest for the ref.
	imageResolvePresent

	// imageResolveMissing means the registry answered definitively that no such
	// manifest exists (a 404 / MANIFEST_UNKNOWN / NAME_UNKNOWN), or the ref is
	// malformed. This is the phantom-card case: a well-formed ref that will
	// ImagePullBackOff at run time.
	imageResolveMissing
)

// ImageResolver reports whether an OCI image reference resolves to an artifact
// that exists in its registry. It is an interface so the reconciler can be
// exercised without network egress: the controller wires a real registry-backed
// resolver, tests wire a deterministic fake.
type ImageResolver interface {
	// Resolve checks the manifest for ref and returns the outcome plus a short
	// human-readable message suitable for a status condition.
	Resolve(ctx context.Context, ref string) (imageResolution, string)
}

// defaultResolveTimeout bounds a single registry check so a slow or hanging
// registry cannot stall a reconcile. The reconcile's own context still applies;
// this only caps the network portion.
const defaultResolveTimeout = 15 * time.Second

// registryImageResolver checks manifest existence against the real registry
// using a HEAD request. It authenticates only with credentials already on the
// controller host (DefaultKeychain: docker config, cloud helpers, else
// anonymous). It intentionally does not read per-namespace imagePullSecrets, so
// a private image the controller cannot reach comes back Unknown rather than
// being wrongly reported missing.
type registryImageResolver struct {
	keychain authn.Keychain
	timeout  time.Duration
}

// NewRegistryImageResolver builds the registry-backed resolver the controller
// runs in production.
func NewRegistryImageResolver() ImageResolver {
	return &registryImageResolver{
		keychain: authn.DefaultKeychain,
		timeout:  defaultResolveTimeout,
	}
}

func (g *registryImageResolver) Resolve(ctx context.Context, ref string) (imageResolution, string) {
	parsed, err := name.ParseReference(ref)
	if err != nil {
		// A malformed ref will never resolve, so this is a definitive miss, not
		// an inconclusive check — requeuing would only re-fail it.
		return imageResolveMissing, fmt.Sprintf("invalid image reference: %v", err)
	}

	timeout := g.timeout
	if timeout <= 0 {
		timeout = defaultResolveTimeout
	}
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	if _, err := remote.Head(parsed, remote.WithContext(ctx), remote.WithAuthFromKeychain(g.keychain)); err != nil {
		return classifyResolveError(parsed.String(), err)
	}
	return imageResolvePresent, fmt.Sprintf("manifest found in registry: %s", parsed.String())
}

// classifyResolveError decides whether a failed HEAD means the artifact is
// definitively absent or merely could not be confirmed. Only a registry that
// affirmatively says "no such manifest" counts as missing; everything else
// (auth, rate limit, DNS, TLS, timeout) is Unknown.
func classifyResolveError(ref string, err error) (imageResolution, string) {
	var terr *transport.Error
	if errors.As(err, &terr) {
		for _, ec := range terr.Errors {
			switch ec.Code {
			case transport.ManifestUnknownErrorCode, transport.NameUnknownErrorCode:
				return imageResolveMissing, fmt.Sprintf("no manifest for %s in its registry: %s", ref, ec.Message)
			}
		}
		switch terr.StatusCode {
		case http.StatusNotFound:
			return imageResolveMissing, fmt.Sprintf("registry has no manifest for %s (404)", ref)
		case http.StatusUnauthorized, http.StatusForbidden:
			// The pod may still pull this with its own imagePullSecrets; the
			// controller just cannot confirm it, so do not condemn the card.
			return imageResolveUnknown, fmt.Sprintf("registry requires credentials the controller does not hold for %s; existence not confirmed", ref)
		}
	}
	return imageResolveUnknown, fmt.Sprintf("could not reach registry to confirm %s: %v", ref, err)
}
