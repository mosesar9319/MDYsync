#!/usr/bin/env python3
"""Unit tests for page_ocr_align.fetch_page_pdf: the page PDF comes straight from
shas.org when its certificate checks out, and through the DafSync site's own
/api/daf-page when (and only when) that certificate is refused.

The OCR dependencies (cv2, pytesseract, rapidfuzz, google-auth) are stubbed out --
only the download logic runs, so this needs just the stdlib:
`python3 test_fetch_page_pdf.py`.
"""
import os
import ssl
import sys
import tempfile
import types
import unittest
import urllib.error
from unittest import mock

for name in ('cv2', 'pytesseract', 'rapidfuzz', 'google', 'google.auth', 'google.auth.transport',
             'google.auth.transport.requests', 'google.oauth2', 'google.oauth2.service_account'):
    sys.modules.setdefault(name, types.ModuleType(name))
sys.modules['rapidfuzz'].fuzz = object()
sys.modules['google.auth.transport.requests'].Request = object
sys.modules['google.oauth2'].service_account = sys.modules['google.oauth2.service_account']
caption_stub = types.ModuleType('caption_ocr_align')
caption_stub.normalize_word = lambda w: w
caption_stub.load_canonical = lambda *a, **k: None
sys.modules['caption_ocr_align'] = caption_stub

import page_ocr_align  # noqa: E402

PDF = b'%PDF-1.6 ' + b'x' * 6000


def cert_error():
    return urllib.error.URLError(ssl.SSLCertVerificationError(
        1, "certificate verify failed: Hostname mismatch, certificate is not valid for 'www.shas.org'"))


class FetchPagePdfTests(unittest.TestCase):
    def fetch(self, downloads):
        """downloads: a list of results/exceptions, one per _download_pdf call, in order."""
        urls = []

        def fake(url):
            urls.append(url)
            result = downloads[len(urls) - 1]
            if isinstance(result, Exception):
                raise result
            return result

        with tempfile.TemporaryDirectory() as tmp, mock.patch.object(page_ocr_align, '_download_pdf', fake):
            out = os.path.join(tmp, 'page.pdf')
            try:
                page_ocr_align.fetch_page_pdf('Bekhorot', 19, 'b', out)
                with open(out, 'rb') as handle:
                    written = handle.read()
            except Exception as error:  # noqa: BLE001 -- handed back for the assertions
                return urls, error, None
        return urls, None, written

    def test_comes_straight_from_shas_org_when_its_certificate_is_fine(self):
        urls, error, written = self.fetch([PDF])
        self.assertIsNone(error)
        self.assertEqual(written, PDF)
        self.assertEqual(len(urls), 1)
        self.assertTrue(urls[0].startswith('https://www.shas.org/daf-pdf/api/?masechta=bechoros&daf=19&amud=b'))

    def test_a_refused_certificate_falls_back_to_the_dafsync_proxy(self):
        urls, error, written = self.fetch([cert_error(), PDF])
        self.assertIsNone(error)
        self.assertEqual(written, PDF)
        self.assertEqual(urls[1], f'{page_ocr_align.PAGE_PROXY_BASE}/api/daf-page?tractate=Bekhorot&daf=19&amud=b')

    def test_other_failures_are_not_rerouted(self):
        for failure in (urllib.error.URLError(ConnectionRefusedError()),
                        urllib.error.HTTPError('u', 503, 'down', {}, None)):
            urls, error, _ = self.fetch([failure, PDF])
            self.assertIs(error, failure)
            self.assertEqual(len(urls), 1)

    def test_a_page_the_proxy_does_not_have_is_reported_as_missing(self):
        urls, error, _ = self.fetch([cert_error(), urllib.error.HTTPError('u', 404, 'no', {}, None)])
        self.assertIsInstance(error, RuntimeError)
        self.assertIn('No page image available for Bekhorot 19b', str(error))

    def test_only_a_pdf_is_accepted_from_either_route(self):
        for answers in ([b'<html>' + b'x' * 6000], [cert_error(), b'<html>' + b'x' * 6000]):
            urls, error, written = self.fetch(answers)
            self.assertIsInstance(error, RuntimeError)
            self.assertIsNone(written)


if __name__ == '__main__':
    unittest.main()
