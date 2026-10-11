# Test fixtures

`test-cert.crt` and `test-cert.key` are a self-signed certificate and its key,
generated only for the test suite. `other.key` is an unrelated key used to
check that a mismatched key is rejected.

These keys protect nothing. Never use them outside tests.
