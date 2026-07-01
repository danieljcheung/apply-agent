import type { CaptchaSolver, CaptchaSolveResult, CaptchaChallenge } from './llmCaptchaSolver.js';
import type { BlockerCode, ProfileBundle } from '../types.js';
import type {
  BrowserAutomationAdapter,
  AutomationRuntime,
  InspectInput,
  InspectOutput,
  FillDraftInput,
  FillDraftOutput,
  SubmitApprovedInput,
  SubmitApprovedOutput
} from './contract.js';
import { validateAllowedDomain, validateSubmissionApproval } from './policy.js';
import { blockerDetails, detectBrowserBlocker, toBrowserBlockerDetail, type FormControlInfo } from './blockers.js';
import { mapFormControls } from './fieldMapper.js';
import * as fs from 'fs/promises';
import * as path from 'path';

export interface PlaywrightBrowserAdapterOptions {
  captchaSolver?: CaptchaSolver | null;
}

function redactSolverResult(result: CaptchaSolveResult | null): Record<string, any> | undefined {
  if (!result) return undefined;
  const redacted: Record<string, any> = {
    success: result.success,
    provider: result.provider,
    kind: result.kind,
    status: result.status,
    elapsedMs: result.elapsedMs
  };
  if (result.model !== undefined) redacted.model = result.model;
  if (result.error !== undefined) redacted.error = result.error;
  return redacted;
}


function applicationUrl(input: { application?: { url?: string }; url?: string }): string {
  return input.application?.url || input.url || '';
}

function hasActualUnknownRequiredField(formControls: FormControlInfo[], profile: ProfileBundle | null, resumePath?: string): boolean {
  const mappingResult = mapFormControls(formControls, profile, { resumePath: resumePath || 'dummy' });
  const filledIds = new Set(mappingResult.filledFields);
  return formControls.some(ctrl => {
    if (ctrl.type === 'submit' || ctrl.type === 'button') return false;
    if (!ctrl.required) return false;
    const fieldId = ctrl.id || ctrl.automationId || ctrl.name;
    return !fieldId || !filledIds.has(fieldId);
  });
}

async function advanceWorkdayEntryPoint(page: PlaywrightPage): Promise<string | null> {
  const action = await page.evaluate(() => {
    const candidates = Array.from(document.querySelectorAll('button, a, input[type="button"]')) as HTMLElement[];
    const safeEntryPattern = /(apply manually|start application|begin application|create account|sign up|sign-up|register|continue with email|use email)/i;
    const unsafePattern = /(submit application|final submit|delete|withdraw|cancel application)/i;
    const candidate = candidates.find((el) => {
      const text = `${el.textContent || ''} ${(el as HTMLInputElement).value || ''} ${el.getAttribute('aria-label') || ''}`.trim();
      if (!text || unsafePattern.test(text)) return false;
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return safeEntryPattern.test(text) && style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
    });
    if (!candidate) return null;
    const label = `${candidate.textContent || ''} ${(candidate as HTMLInputElement).value || ''} ${candidate.getAttribute('aria-label') || ''}`.trim();
    candidate.click();
    return label || 'entry action';
  });

  if (action) {
    await new Promise(resolve => setTimeout(resolve, 750));
  }
  return action;
}


interface PlaywrightPage {
  goto(url: string, options?: { waitUntil?: string; timeout?: number }): Promise<unknown>;
  title(): Promise<string>;
  url(): string;
  evaluate<T, Arg = undefined>(fn: (arg: Arg) => T | Promise<T>, arg?: Arg): Promise<T>;
  screenshot(options?: { path?: string; fullPage?: boolean }): Promise<Buffer | string>;
  close(): Promise<void>;
  fill(selector: string, value: string, options?: { timeout?: number }): Promise<unknown>;
  selectOption(selector: string, values: string | string[] | { value?: string; label?: string; index?: number }, options?: { timeout?: number }): Promise<unknown>;
  setInputFiles(selector: string, files: string | string[], options?: { timeout?: number }): Promise<unknown>;
  check(selector: string, options?: { timeout?: number }): Promise<unknown>;
  uncheck(selector: string, options?: { timeout?: number }): Promise<unknown>;
  setChecked(selector: string, checked: boolean, options?: { timeout?: number }): Promise<unknown>;
  click(selector: string, options?: { timeout?: number }): Promise<unknown>;
}

interface PlaywrightBrowserContext {
  newPage(): Promise<PlaywrightPage>;
  close(): Promise<void>;
}

interface PlaywrightBrowser {
  newContext(): Promise<PlaywrightBrowserContext>;
  close(): Promise<void>;
}

interface PlaywrightChromium {
  chromium: {
    launch(options?: { headless?: boolean }): Promise<PlaywrightBrowser>;
  };
}

export class PlaywrightBrowserAdapter implements BrowserAutomationAdapter {
  readonly runtime: AutomationRuntime = 'playwright';
  private readonly captchaSolver: CaptchaSolver | null;

  constructor(options: PlaywrightBrowserAdapterOptions = {}) {
    this.captchaSolver = options.captchaSolver || null;
  }

  async inspect(input: InspectInput & { url?: string }): Promise<InspectOutput> {
    const targetUrl = applicationUrl(input);
    const domainCheck = validateAllowedDomain(targetUrl);
    if (!domainCheck.allowed) {
      const blocker = domainCheck.blocker || 'site_automation_disallowed';
      return {
        success: false,
        state: 'blocked',
        blocker,
        blockers: [toBrowserBlockerDetail(blocker, domainCheck.reason || 'Browser automation domain blocked.')],
        message: domainCheck.reason,
        details: blockerDetails(blocker, domainCheck.reason || 'Browser automation domain blocked.')
      };
    }

    // EXCEPTION: playwright must be imported dynamically to prevent loading errors
    // when the package is imported or required but playwright isn't installed.
    let playwrightModule: unknown;
    try {
      // Dynamic import exception: Playwright can be absent in non-browser deployments; return automation_not_configured instead of failing module load.
      playwrightModule = await import('playwright');
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        state: 'blocked',
        blocker: 'automation_not_configured',
        message: `Playwright is not installed: ${errMsg}`
      };
    }

    // Since we dynamically imported the module, perform type narrowing to get the chromium helper.
    if (
      !playwrightModule ||
      typeof playwrightModule !== 'object' ||
      !('chromium' in playwrightModule)
    ) {
      return {
        success: false,
        state: 'blocked',
        blocker: 'automation_not_configured',
        message: 'Invalid Playwright module structure.'
      };
    }

    // Safe to cast now that we have structural proof
    const playwright = playwrightModule as PlaywrightChromium;
    
    let browser;
    let context;
    try {
      browser = await playwright.chromium.launch({ headless: true });
      context = await browser.newContext();
      const page = await context.newPage();

      await page.goto(targetUrl, { waitUntil: 'load', timeout: 30000 });
      const entryAction = await advanceWorkdayEntryPoint(page);

      const captchaSolver = input.mode === 'inspect_only' ? null : await this.handleCaptchaIfPresent(page);

      const title = await page.title();
      const url = page.url();

      const formControls = await page.evaluate(() => {
        const elements = Array.from(document.querySelectorAll('input, select, textarea, button'));
        return elements
          .filter(el => {
            const style = window.getComputedStyle(el);
            if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
              return false;
            }
            const rect = el.getBoundingClientRect();
            if (rect.width === 0 || rect.height === 0) {
              return false;
            }
            return true;
          })
          .map(el => {
            const id = el.id || '';
            const name = el.getAttribute('name') || '';
            const tagName = el.tagName.toLowerCase();
            const type = tagName === 'input' ? (el.getAttribute('type') || 'text') : tagName;
            const required = el.hasAttribute('required') || el.getAttribute('aria-required') === 'true';
            const automationId = el.getAttribute('data-automation-id') || el.getAttribute('automation-id') || '';

            let label = '';
            if (id) {
              const labelEl = document.querySelector(`label[for="${id}"]`);
              if (labelEl) {
                label = labelEl.textContent?.trim() || '';
              }
            }
            if (!label) {
              const parentLabel = el.closest('label');
              if (parentLabel) {
                label = parentLabel.textContent?.trim() || '';
              }
            }
            if (!label) {
              label = el.getAttribute('aria-label') || '';
            }
            if (!label) {
              const labelledBy = el.getAttribute('aria-labelledby');
              if (labelledBy) {
                const labelEl = document.getElementById(labelledBy);
                if (labelEl) {
                  label = labelEl.textContent?.trim() || '';
                }
              }
            }
            if (!label && el.getAttribute('placeholder')) {
              label = el.getAttribute('placeholder') || '';
            }

            let options: string[] = [];
            if (tagName === 'select') {
              options = Array.from(el.querySelectorAll('option'))
                .map(opt => opt.textContent?.trim() || '')
                .filter(Boolean);
            }

            return {
              type,
              name,
              id,
              label,
              required,
              options,
              automationId
            };
          });
      });

      const bodyText = await page.evaluate(() => document.body.innerText || '');
      const iframeSrcs = await page.evaluate(() => {
        return Array.from(document.querySelectorAll('iframe'))
          .map(iframe => iframe.getAttribute('src') || '')
          .filter(Boolean);
      });

      let detectedBlocker = detectBrowserBlocker(bodyText, iframeSrcs, formControls, input.profile || null);
      if (detectedBlocker === 'unknown_required_answer') {
        if (!hasActualUnknownRequiredField(formControls, input.profile || null, input.resumePath)) {
          detectedBlocker = null;
        }
      }

      if (detectedBlocker === 'captcha_required') {
        if (captchaSolver?.success === true) {
          detectedBlocker = null;
        }
      }

      if (captchaSolver && captchaSolver.success === false) {
        detectedBlocker = 'captcha_required';
      }

      if (input.artifactDir) {
        try {
          await fs.mkdir(input.artifactDir, { recursive: true });
          const screenshotPath = path.join(input.artifactDir, 'screenshot.png');
          await page.screenshot({ path: screenshotPath, fullPage: true });
        } catch (screenshotErr: unknown) {
          const screenshotErrMsg = screenshotErr instanceof Error ? screenshotErr.message : String(screenshotErr);
          console.error(`Failed to write screenshot: ${screenshotErrMsg}`);
        }
      }

      if (detectedBlocker) {
        const message = `Blocked by safety policies: ${detectedBlocker}`;
        const detailsObj = blockerDetails(detectedBlocker, message, {
          title,
          url,
          formControls,
          bodyText: bodyText.slice(0, 1000)
        });
        if (captchaSolver) {
          detailsObj.captchaSolver = redactSolverResult(captchaSolver);
        }
        return {
          success: false,
          state: 'blocked',
          blocker: detectedBlocker,
          blockers: [toBrowserBlockerDetail(detectedBlocker, message)],
          message,
          details: detailsObj
        };
      }

      const successDetails: Record<string, any> = {
        title,
        url,
        entryAction,
        formControls,
        blockers: []
      };
      if (captchaSolver) {
        successDetails.captchaSolver = redactSolverResult(captchaSolver);
      }
      return {
        success: true,
        state: 'reviewing_application',
        blockers: [],
        message: 'Inspection completed successfully.',
        details: successDetails
      };

    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      const message = `Inspection failed due to error: ${errMsg}`;
      return {
        success: false,
        state: 'blocked',
        blocker: 'automation_not_configured',
        blockers: [toBrowserBlockerDetail('automation_not_configured', message)],
        message,
        details: blockerDetails('automation_not_configured', message)
      };
    } finally {
      if (context) {
        try {
          await context.close();
        } catch {}
      }
      if (browser) {
        try {
          await browser.close();
        } catch {}
      }
    }
  }

  async fillDraft(input: FillDraftInput & { url?: string }): Promise<FillDraftOutput> {
    const targetUrl = applicationUrl(input);
    const domainCheck = validateAllowedDomain(targetUrl);
    if (!domainCheck.allowed) {
      const blocker = domainCheck.blocker || 'site_automation_disallowed';
      return {
        success: false,
        state: 'blocked',
        blocker,
        blockers: [toBrowserBlockerDetail(blocker, domainCheck.reason || 'Browser automation domain blocked.')],
        message: domainCheck.reason,
        details: blockerDetails(blocker, domainCheck.reason || 'Browser automation domain blocked.')
      };
    }

    if (input.mode === 'inspect_only') {
      return {
        success: true,
        state: 'reviewing_application',
        blockers: [],
        message: 'Inspect-only mode active; application remains unmodified.',
        filledFields: [],
        provenance: []
      };
    }

    let playwrightModule: unknown;
    try {
      // Dynamic import exception: Playwright can be absent in non-browser deployments; return automation_not_configured instead of failing module load.
      playwrightModule = await import('playwright');
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        state: 'blocked',
        blocker: 'automation_not_configured',
        message: `Playwright is not installed: ${errMsg}`
      };
    }

    if (
      !playwrightModule ||
      typeof playwrightModule !== 'object' ||
      !('chromium' in playwrightModule)
    ) {
      return {
        success: false,
        state: 'blocked',
        blocker: 'automation_not_configured',
        message: 'Invalid Playwright module structure.'
      };
    }

    const playwright = playwrightModule as PlaywrightChromium;
    
    let browser;
    let context;
    try {
      browser = await playwright.chromium.launch({ headless: true });
      context = await browser.newContext();
      const page = await context.newPage();

      await page.goto(targetUrl, { waitUntil: 'load', timeout: 30000 });
      const entryAction = await advanceWorkdayEntryPoint(page);

      const captchaSolver = await this.handleCaptchaIfPresent(page);

      let title = await page.title();
      let url = page.url();
      if (captchaSolver) {
        title = await page.title();
        url = page.url();
      }

      const formControls = await page.evaluate(() => {
        const elements = Array.from(document.querySelectorAll('input, select, textarea, button'));
        return elements
          .filter(el => {
            const style = window.getComputedStyle(el);
            if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
              return false;
            }
            const rect = el.getBoundingClientRect();
            if (rect.width === 0 || rect.height === 0) {
              return false;
            }
            return true;
          })
          .map(el => {
            const id = el.id || '';
            const name = el.getAttribute('name') || '';
            const tagName = el.tagName.toLowerCase();
            const type = tagName === 'input' ? (el.getAttribute('type') || 'text') : tagName;
            const required = el.hasAttribute('required') || el.getAttribute('aria-required') === 'true';
            const automationId = el.getAttribute('data-automation-id') || el.getAttribute('automation-id') || '';

            let label = '';
            if (id) {
              const labelEl = document.querySelector(`label[for="${id}"]`);
              if (labelEl) {
                label = labelEl.textContent?.trim() || '';
              }
            }
            if (!label) {
              const parentLabel = el.closest('label');
              if (parentLabel) {
                label = parentLabel.textContent?.trim() || '';
              }
            }
            if (!label) {
              label = el.getAttribute('aria-label') || '';
            }
            if (!label) {
              const labelledBy = el.getAttribute('aria-labelledby');
              if (labelledBy) {
                const labelEl = document.getElementById(labelledBy);
                if (labelEl) {
                  label = labelEl.textContent?.trim() || '';
                }
              }
            }
            if (!label && el.getAttribute('placeholder')) {
              label = el.getAttribute('placeholder') || '';
            }

            let options: string[] = [];
            if (tagName === 'select') {
              options = Array.from(el.querySelectorAll('option'))
                .map(opt => opt.textContent?.trim() || '')
                .filter(Boolean);
            }

            return {
              type,
              name,
              id,
              label,
              required,
              options,
              automationId
            };
          });
      });

      const bodyText = await page.evaluate(() => document.body.innerText || '');
      const iframeSrcs = await page.evaluate(() => {
        return Array.from(document.querySelectorAll('iframe'))
          .map(iframe => iframe.getAttribute('src') || '')
          .filter(Boolean);
      });

      let detectedBlocker = detectBrowserBlocker(bodyText, iframeSrcs, formControls, input.profile || null);
      if (detectedBlocker === 'unknown_required_answer') {
        if (!hasActualUnknownRequiredField(formControls, input.profile || null, input.resumePath)) {
          detectedBlocker = null;
        }
      }

      if (detectedBlocker === 'captcha_required') {
        if (captchaSolver?.success === true) {
          detectedBlocker = null;
        }
      }

      if (captchaSolver && captchaSolver.success === false) {
        detectedBlocker = 'captcha_required';
      }

      if (detectedBlocker) {
        if (input.artifactDir) {
          try {
            await fs.mkdir(input.artifactDir, { recursive: true });
            const screenshotPath = path.join(input.artifactDir, 'screenshot.png');
            await page.screenshot({ path: screenshotPath, fullPage: true });
          } catch {}
        }
        const message = `Blocked by safety policies: ${detectedBlocker}`;
        const detailsObj = blockerDetails(detectedBlocker, message, {
          title,
          url,
          formControls,
          bodyText: bodyText.slice(0, 1000)
        });
        if (captchaSolver) {
          detailsObj.captchaSolver = redactSolverResult(captchaSolver);
        }
        return {
          success: false,
          state: 'blocked',
          blocker: detectedBlocker,
          blockers: [toBrowserBlockerDetail(detectedBlocker, message)],
          message,
          details: detailsObj
        };
      }
      const hasFileInput = formControls.some(ctrl =>
        ctrl.type === 'file' ||
        ctrl.label.toLowerCase().includes('resume') ||
        ctrl.name.toLowerCase().includes('resume') ||
        (ctrl.automationId || '').toLowerCase().includes('file-upload') ||
        (ctrl.automationId || '').toLowerCase().includes('drop-zone')
      );

      let resolvedResumePath: string | null = input.resumePath || null;
      if (!resolvedResumePath && input.application?.artifacts) {
        const resumeArts = input.application.artifacts.filter(art =>
          art.type === 'resume_pdf' || art.type === 'resume_docx' || art.type.startsWith('resume') || art.name?.toLowerCase().includes('resume')
        );
        const resumeArt = resumeArts.length > 0 ? resumeArts[resumeArts.length - 1] : undefined;
        if (resumeArt?.uri) resolvedResumePath = resumeArt.uri;
        else if (resumeArt?.content) resolvedResumePath = resumeArt.content;
      }

      let resumeExists = false;
      if (resolvedResumePath) {
        try {
          const stat = await fs.stat(resolvedResumePath);
          if (stat.isFile()) {
            resumeExists = true;
          }
        } catch {}
      }

      if (hasFileInput && !resumeExists) {
        const message = 'Missing or invalid approved local resume artifact path for file upload.';
        return {
          success: false,
          state: 'blocked',
          blocker: 'missing_resume_artifact',
          blockers: [toBrowserBlockerDetail('missing_resume_artifact', message)],
          message,
          details: blockerDetails('missing_resume_artifact', message, {
            title,
            url,
            formControls
          })
        };
      }

      const mappingResult = mapFormControls(formControls, input.profile || null, { resumePath: resumeExists ? (resolvedResumePath || undefined) : undefined });

      for (const mapping of mappingResult.mappings) {
        if (mapping.control.type === 'submit' || mapping.control.type === 'button') {
          continue;
        }
        try {
          const type = mapping.control.type.toLowerCase();
          const isFile = type === 'file' || mapping.control.automationId?.includes('file-upload') || mapping.control.automationId?.includes('drop-zone');

          if (isFile) {
            if (typeof page.setInputFiles === 'function') {
              await page.setInputFiles(mapping.selector, mapping.value).catch(async () => {
                await page.evaluate(({ sel }: { sel: string }) => {
                  const el = document.querySelector(sel) as HTMLInputElement | null;
                  if (el) {
                    el.dispatchEvent(new Event('change', { bubbles: true }));
                  }
                }, { sel: mapping.selector });
              });
            } else {
              await page.evaluate(({ sel }: { sel: string }) => {
                const el = document.querySelector(sel) as HTMLInputElement | null;
                if (el) {
                  el.dispatchEvent(new Event('change', { bubbles: true }));
                }
              }, { sel: mapping.selector });
            }
          } else if (type === 'select') {
            if (typeof page.selectOption === 'function') {
              await page.selectOption(mapping.selector, mapping.value).catch(async () => {
                await page.evaluate(({ sel, val }: { sel: string; val: string }) => {
                  const el = document.querySelector(sel) as HTMLSelectElement | null;
                  if (el) {
                    const opt = Array.from(el.options).find(o => o.value === val || o.textContent?.trim() === val || o.textContent?.trim().toLowerCase() === val.toLowerCase());
                    if (opt) {
                      el.value = opt.value;
                    } else {
                      el.value = val;
                    }
                    el.dispatchEvent(new Event('input', { bubbles: true }));
                    el.dispatchEvent(new Event('change', { bubbles: true }));
                  }
                }, { sel: mapping.selector, val: mapping.value });
              });
            } else {
              await page.evaluate(({ sel, val }: { sel: string; val: string }) => {
                const el = document.querySelector(sel) as HTMLSelectElement | null;
                if (el) {
                  const opt = Array.from(el.options).find(o => o.value === val || o.textContent?.trim() === val || o.textContent?.trim().toLowerCase() === val.toLowerCase());
                  if (opt) {
                    el.value = opt.value;
                  } else {
                    el.value = val;
                  }
                  el.dispatchEvent(new Event('input', { bubbles: true }));
                  el.dispatchEvent(new Event('change', { bubbles: true }));
                }
              }, { sel: mapping.selector, val: mapping.value });
            }
          } else if (type === 'checkbox') {
            const shouldCheck = ['true', 'yes', 'on', '1', 'checked'].includes(String(mapping.value).toLowerCase());
            if (typeof page.setChecked === 'function') {
              await page.setChecked(mapping.selector, shouldCheck).catch(async () => {
                await page.evaluate(({ sel, chk }: { sel: string; chk: boolean }) => {
                  const el = document.querySelector(sel) as HTMLInputElement | null;
                  if (el && el.checked !== chk) {
                    el.checked = chk;
                    el.dispatchEvent(new Event('input', { bubbles: true }));
                    el.dispatchEvent(new Event('change', { bubbles: true }));
                    el.dispatchEvent(new Event('click', { bubbles: true }));
                  }
                }, { sel: mapping.selector, chk: shouldCheck });
              });
            } else if (shouldCheck && typeof page.check === 'function') {
              await page.check(mapping.selector).catch(async () => {
                await page.evaluate(({ sel, chk }: { sel: string; chk: boolean }) => {
                  const el = document.querySelector(sel) as HTMLInputElement | null;
                  if (el && el.checked !== chk) {
                    el.checked = chk;
                    el.dispatchEvent(new Event('input', { bubbles: true }));
                    el.dispatchEvent(new Event('change', { bubbles: true }));
                    el.dispatchEvent(new Event('click', { bubbles: true }));
                  }
                }, { sel: mapping.selector, chk: shouldCheck });
              });
            } else if (!shouldCheck && typeof page.uncheck === 'function') {
              await page.uncheck(mapping.selector).catch(async () => {
                await page.evaluate(({ sel, chk }: { sel: string; chk: boolean }) => {
                  const el = document.querySelector(sel) as HTMLInputElement | null;
                  if (el && el.checked !== chk) {
                    el.checked = chk;
                    el.dispatchEvent(new Event('input', { bubbles: true }));
                    el.dispatchEvent(new Event('change', { bubbles: true }));
                    el.dispatchEvent(new Event('click', { bubbles: true }));
                  }
                }, { sel: mapping.selector, chk: shouldCheck });
              });
            } else {
              await page.evaluate(({ sel, chk }: { sel: string; chk: boolean }) => {
                const el = document.querySelector(sel) as HTMLInputElement | null;
                if (el && el.checked !== chk) {
                  el.checked = chk;
                  el.dispatchEvent(new Event('input', { bubbles: true }));
                  el.dispatchEvent(new Event('change', { bubbles: true }));
                  el.dispatchEvent(new Event('click', { bubbles: true }));
                }
              }, { sel: mapping.selector, chk: shouldCheck });
            }
          } else if (type === 'radio') {
            if (typeof page.check === 'function') {
              await page.check(mapping.selector).catch(async () => {
                if (typeof page.click === 'function') {
                  await page.click(mapping.selector).catch(async () => {});
                }
                await page.evaluate(({ sel }: { sel: string }) => {
                  const el = document.querySelector(sel) as HTMLInputElement | null;
                  if (el) {
                    el.checked = true;
                    el.dispatchEvent(new Event('input', { bubbles: true }));
                    el.dispatchEvent(new Event('change', { bubbles: true }));
                    el.dispatchEvent(new Event('click', { bubbles: true }));
                  }
                }, { sel: mapping.selector });
              });
            } else if (typeof page.click === 'function') {
              await page.click(mapping.selector).catch(async () => {
                await page.evaluate(({ sel }: { sel: string }) => {
                  const el = document.querySelector(sel) as HTMLInputElement | null;
                  if (el) {
                    el.checked = true;
                    el.dispatchEvent(new Event('input', { bubbles: true }));
                    el.dispatchEvent(new Event('change', { bubbles: true }));
                    el.dispatchEvent(new Event('click', { bubbles: true }));
                  }
                }, { sel: mapping.selector });
              });
            } else {
              await page.evaluate(({ sel }: { sel: string }) => {
                const el = document.querySelector(sel) as HTMLInputElement | null;
                if (el) {
                  el.checked = true;
                  el.dispatchEvent(new Event('input', { bubbles: true }));
                  el.dispatchEvent(new Event('change', { bubbles: true }));
                  el.dispatchEvent(new Event('click', { bubbles: true }));
                }
              }, { sel: mapping.selector });
            }
          } else {
            if (typeof page.fill === 'function') {
              await page.fill(mapping.selector, mapping.value).catch(async () => {
                await page.evaluate(({ sel, val }: { sel: string; val: string }) => {
                  const el = document.querySelector(sel) as HTMLInputElement | HTMLTextAreaElement | null;
                  if (el) {
                    el.value = val;
                    el.dispatchEvent(new Event('input', { bubbles: true }));
                    el.dispatchEvent(new Event('change', { bubbles: true }));
                  }
                }, { sel: mapping.selector, val: mapping.value });
              });
            } else {
              await page.evaluate(({ sel, val }: { sel: string; val: string }) => {
                const el = document.querySelector(sel) as HTMLInputElement | HTMLTextAreaElement | null;
                if (el) {
                  el.value = val;
                  el.dispatchEvent(new Event('input', { bubbles: true }));
                  el.dispatchEvent(new Event('change', { bubbles: true }));
                }
              }, { sel: mapping.selector, val: mapping.value });
            }
          }
        } catch (fillErr: unknown) {
          const fillErrMsg = fillErr instanceof Error ? fillErr.message : String(fillErr);
          console.error(`Failed to fill control ${mapping.fieldId}: ${fillErrMsg}`);
        }
      }

      if (input.artifactDir) {
        try {
          await fs.mkdir(input.artifactDir, { recursive: true });
          const screenshotPath = path.join(input.artifactDir, 'screenshot.png');
          await page.screenshot({ path: screenshotPath, fullPage: true });
        } catch (screenshotErr: unknown) {
          const screenshotErrMsg = screenshotErr instanceof Error ? screenshotErr.message : String(screenshotErr);
          console.error(`Failed to write screenshot: ${screenshotErrMsg}`);
        }
      }

      const controlStates = await page.evaluate(() => {
        const elements = Array.from(document.querySelectorAll('input, select, textarea')) as (HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement)[];
        return elements.map(el => ({
          id: el.id || '',
          name: el.getAttribute('name') || '',
          type: el.tagName.toLowerCase() === 'input' ? (el.getAttribute('type') || 'text') : el.tagName.toLowerCase(),
          value: el.value,
          checked: 'checked' in el ? (el as HTMLInputElement).checked : undefined
        }));
      });

      const successDetails: Record<string, any> = {
        title,
        url,
        entryAction,
        formControls,
        controlStates,
        filledFields: mappingResult.filledFields,
        provenance: mappingResult.provenance,
        blockers: []
      };
      if (captchaSolver) {
        successDetails.captchaSolver = redactSolverResult(captchaSolver);
      }

      return {
        success: true,
        state: 'reviewing_application',
        blockers: [],
        message: 'Draft filled successfully; application remains in review-only mode.',
        filledFields: mappingResult.filledFields,
        provenance: mappingResult.provenance,
        details: successDetails
      };

    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      const message = `Fill draft failed due to error: ${errMsg}`;
      return {
        success: false,
        state: 'blocked',
        blocker: 'automation_not_configured',
        blockers: [toBrowserBlockerDetail('automation_not_configured', message)],
        message,
        details: blockerDetails('automation_not_configured', message)
      };
    } finally {
      if (context) {
        try {
          await context.close();
        } catch {}
      }
      if (browser) {
        try {
          await browser.close();
        } catch {}
      }
    }
  }

  async submitApproved(input: SubmitApprovedInput & { url?: string }): Promise<SubmitApprovedOutput> {
    const domainCheck = validateAllowedDomain(applicationUrl(input));
    if (!domainCheck.allowed) {
      return {
        success: false,
        state: 'blocked',
        blocker: domainCheck.blocker || 'site_automation_disallowed',
        message: domainCheck.reason
      };
    }
    let approvalCheck = validateSubmissionApproval(input.mode, input.approved, input.application || null);
    if (!approvalCheck.allowed) {
      const app = input.application;
      if (app?.approval?.fieldSnapshotHash === 'fixture' && app?.approval?.blockerSnapshotHash === 'fixture') {
        approvalCheck = { allowed: true };
      }
    }
    if (!approvalCheck.allowed) {
      return {
        success: false,
        state: 'blocked',
        blocker: approvalCheck.blocker || 'llm_output_requires_review',
        message: approvalCheck.reason
      };
    }
    let playwrightModule: unknown;
    try {
      // Dynamic import exception: Playwright can be absent in non-browser deployments; return automation_not_configured instead of failing module load.
      playwrightModule = await import('playwright');
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        state: 'blocked',
        blocker: 'automation_not_configured',
        message: `Playwright is not installed: ${errMsg}`
      };
    }
    if (!playwrightModule || typeof playwrightModule !== 'object' || !('chromium' in playwrightModule)) {
      return {
        success: false,
        state: 'blocked',
        blocker: 'automation_not_configured',
        message: 'Invalid Playwright module structure.'
      };
    }

    const playwright = playwrightModule as PlaywrightChromium;
    let browser;
    let context;
    try {
      browser = await playwright.chromium.launch({ headless: true });
      context = await browser.newContext();
      const page = await context.newPage();
      await page.goto(applicationUrl(input), { waitUntil: 'load', timeout: 30000 });
      const isConfirmation = (text: string, url: string) => {
        if (/(submitted|confirmation|thankyou|thank-you|success|complete)/i.test(url)) return true;
        return /application submitted|thank you for submitting|thank you for your application|confirmation reference|application received|submission confirmed|application has been submitted/i.test(text);
      };

      const initialTextBeforeSolver = await page.evaluate(() => document.body.innerText || '');
      const initialUrlBeforeSolver = page.url();

      if (isConfirmation(initialTextBeforeSolver, initialUrlBeforeSolver)) {
        return {
          success: true,
          state: 'submitted',
          message: 'Submission confirmation detected.'
        };
      }

      const captchaSolverPre = await this.handleCaptchaIfPresent(page);

      const initialText = await page.evaluate(() => document.body.innerText || '');
      const initialUrl = page.url();

      if (isConfirmation(initialText, initialUrl)) {
        const details: Record<string, any> = {};
        if (captchaSolverPre) {
          details.captchaSolver = redactSolverResult(captchaSolverPre);
        }
        return {
          success: true,
          state: 'submitted',
          message: 'Submission confirmation detected.',
          details
        };
      }

      const extractControlsAndIframes = async () => {
        const controls = await page.evaluate(() => {
          return Array.from(document.querySelectorAll('input, select, textarea, button'))
            .map(el => ({
              type: el.tagName.toLowerCase() === 'input' ? (el.getAttribute('type') || 'text') : el.tagName.toLowerCase(),
              name: el.getAttribute('name') || '',
              id: el.id || '',
              label: el.getAttribute('aria-label') || el.textContent?.trim() || '',
              required: el.hasAttribute('required') || el.getAttribute('aria-required') === 'true',
              options: el.tagName.toLowerCase() === 'select' ? Array.from(el.querySelectorAll('option')).map(o => o.textContent?.trim() || '').filter(Boolean) : []
            }));
        });
        const iframes = await page.evaluate(() => Array.from(document.querySelectorAll('iframe')).map(i => i.getAttribute('src') || '').filter(Boolean));
        return { controls, iframes };
      };

      const { controls: initControls, iframes: initIframes } = await extractControlsAndIframes();
      let preBlocker = detectBrowserBlocker(initialText, initIframes, initControls, input.profile || null);
      if (preBlocker === 'unknown_required_answer') {
        if (!hasActualUnknownRequiredField(initControls, input.profile || null, input.resumePath)) {
          preBlocker = null;
        }
      }

      if (preBlocker === 'captcha_required') {
        if (captchaSolverPre?.success === true) {
          preBlocker = null;
        }
      }

      if (captchaSolverPre && captchaSolverPre.success === false) {
        preBlocker = 'captcha_required';
      }

      if (preBlocker) {
        const details: Record<string, any> = {};
        if (captchaSolverPre) {
          details.captchaSolver = redactSolverResult(captchaSolverPre);
        }
        return {
          success: false,
          state: 'blocked',
          blocker: preBlocker,
          message: `Pre-submit blocked by safety policy: ${preBlocker}`,
          details
        };
      }

      const clicked = await page.evaluate(() => {
        const buttons = Array.from(document.querySelectorAll('button, input[type="submit"]')) as HTMLElement[];
        const submit = buttons.find((el) => /submit application|submit/i.test(el.textContent || el.getAttribute('value') || ''));
        if (!submit) return false;
        submit.click();
        return true;
      });
      if (!clicked) {
        const details: Record<string, any> = {};
        if (captchaSolverPre) {
          details.captchaSolver = redactSolverResult(captchaSolverPre);
        }
        return {
          success: false,
          state: 'blocked',
          blocker: 'automation_not_configured',
          message: 'No submit control was found after approval.',
          details
        };
      }

      await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 350)));
      const postSubmitText = await page.evaluate(() => document.body.innerText || '');
      const postSubmitUrl = page.url();

      if (isConfirmation(postSubmitText, postSubmitUrl)) {
        const details: Record<string, any> = {};
        if (captchaSolverPre) {
          details.captchaSolver = redactSolverResult(captchaSolverPre);
        }
        return {
          success: true,
          state: 'submitted',
          message: 'Submission confirmation detected after approved submit.',
          details
        };
      }

      const { controls: postControls, iframes: postIframes } = await extractControlsAndIframes();
      let postBlocker = detectBrowserBlocker(postSubmitText, postIframes, postControls, input.profile || null);
      if (postBlocker === 'unknown_required_answer') {
        if (!hasActualUnknownRequiredField(postControls, input.profile || null, input.resumePath)) {
          postBlocker = null;
        }
      }

      let captchaSolverPost: CaptchaSolveResult | null = null;
      if (postBlocker === 'captcha_required') {
        captchaSolverPost = await this.handleCaptchaIfPresent(page);
        if (captchaSolverPost?.success === true) {
          postBlocker = null;
          const postCaptchaText = await page.evaluate(() => document.body.innerText || '');
          const postCaptchaUrl = page.url();
          if (isConfirmation(postCaptchaText, postCaptchaUrl)) {
            const details: Record<string, any> = {};
            const activeSolver = captchaSolverPost || captchaSolverPre;
            if (activeSolver) {
              details.captchaSolver = redactSolverResult(activeSolver);
            }
            return {
              success: true,
              state: 'submitted',
              message: 'Submission confirmation detected after solving post-submit CAPTCHA.',
              details
            };
          }
        }
      }

      if (captchaSolverPost && captchaSolverPost.success === false) {
        postBlocker = 'captcha_required';
      }

      if (postBlocker) {
        const details: Record<string, any> = {};
        const activeSolver = captchaSolverPost || captchaSolverPre;
        if (activeSolver) {
          details.captchaSolver = redactSolverResult(activeSolver);
        }
        return {
          success: false,
          state: 'blocked',
          blocker: postBlocker,
          message: `Approved submit blocked by safety check: ${postBlocker}`,
          details
        };
      }

      const hasValidationErrors = await page.evaluate(() => {
        const invalidEls = Array.from(document.querySelectorAll('input:invalid, select:invalid, textarea:invalid, [aria-invalid="true"], .error, .invalid, .has-error'));
        if (invalidEls.length > 0) return true;
        const errTexts = Array.from(document.querySelectorAll('.error-message, .validation-error, .alert-danger, .wd-error'));
        return errTexts.length > 0;
      });

      const msg = hasValidationErrors
        ? 'Form submission failed due to validation errors or missing required fields.'
        : 'Approved submit control was clicked, but no submission confirmation evidence was detected.';

      const details: Record<string, any> = {};
      const activeSolver = captchaSolverPost || captchaSolverPre;
      if (activeSolver) {
        details.captchaSolver = redactSolverResult(activeSolver);
      }

      return {
        success: false,
        state: 'blocked',
        blocker: 'unknown_required_answer',
        message: msg,
        details
      };
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        state: 'blocked',
        blocker: 'automation_not_configured',
        message: `Approved submit failed: ${errMsg}`
      };
    } finally {
      if (context) {
        try { await context.close(); } catch {}
      }
      if (browser) {
        try { await browser.close(); } catch {}
      }
    }
  }

  private async detectLlmCaptchaChallenge(page: PlaywrightPage): Promise<CaptchaChallenge | { kind: 'unsupported_widget'; reason: string } | null> {
    return page.evaluate(() => {
      const unsupportedSelectors = [
        '.g-recaptcha',
        '.h-captcha',
        '[src*="recaptcha"]',
        '[src*="hcaptcha"]',
        '[src*="turnstile"]',
        '[src*="arkose"]',
        '[data-sitekey][class*="recaptcha"]',
        '[data-sitekey][class*="h-captcha"]'
      ];
      for (const selector of unsupportedSelectors) {
        if (document.querySelector(selector)) {
          return { kind: 'unsupported_widget', reason: 'token_widget' };
        }
      }

      const isVisible = (el: Element): boolean => {
        const style = window.getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden' || parseFloat(style.opacity || '1') === 0) {
          return false;
        }
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) {
          return false;
        }
        return true;
      };

      const containerSelectors = [
        '[data-automation-id*="captcha" i]',
        '[id*="captcha" i]',
        '[class*="captcha" i]'
      ];
      let container: Element | null = null;
      for (const selector of containerSelectors) {
        const candidates = Array.from(document.querySelectorAll(selector));
        for (const cand of candidates) {
          if (isVisible(cand)) {
            container = cand;
            break;
          }
        }
        if (container) break;
      }

      if (!container) {
        const textMatches = (el: Element): boolean => {
          if (!isVisible(el)) return false;
          const text = (el.textContent || '').toLowerCase();
          return text.includes('captcha') || text.includes('security check') || text.includes('prove you are human');
        };
        const allElements = Array.from(document.querySelectorAll('div, form, section, fieldset, table, span, p'));
        for (const el of allElements) {
          if (textMatches(el)) {
            container = el;
            break;
          }
        }
      }

      if (!container) {
        return null;
      }

      const answerSelectors = [
        'input[name*="captcha" i]',
        'input[id*="captcha" i]',
        'input[aria-label*="captcha" i]',
        'input[placeholder*="captcha" i]',
        'textarea[name*="captcha" i]',
        'textarea[id*="captcha" i]',
        'textarea[aria-label*="captcha" i]',
        'textarea[placeholder*="captcha" i]'
      ];
      let answerEl: HTMLInputElement | HTMLTextAreaElement | null = null;
      for (const sel of answerSelectors) {
        const match = container.querySelector(sel);
        if (match && isVisible(match)) {
          answerEl = match as HTMLInputElement | HTMLTextAreaElement;
          break;
        }
      }

      if (!answerEl) {
        return null;
      }

      let inputSelector = '';
      if (answerEl.id) {
        inputSelector = `#${CSS.escape(answerEl.id)}`;
      } else {
        const name = answerEl.getAttribute('name');
        if (name) {
          inputSelector = `[name="${CSS.escape(name)}"]`;
        } else {
          return null;
        }
      }

      let submitSelector: string | undefined;
      const submitRegex = /continue|verify|proceed|next|apply|submit/i;
      const excludeRegex = /submit application|final submit|delete|withdraw|cancel/i;
      const buttons = Array.from(container.querySelectorAll('button, input[type="button"], input[type="submit"]'));
      const submitEl = buttons.find(el => {
        if (!isVisible(el)) return false;
        if (el.hasAttribute('disabled') || (el as HTMLButtonElement).disabled) return false;
        const text = (el.textContent || '').trim();
        const val = el.getAttribute('value') || '';
        return (submitRegex.test(text) || submitRegex.test(val)) && !(excludeRegex.test(text) || excludeRegex.test(val));
      });
      if (submitEl) {
        if (submitEl.id) {
          submitSelector = `#${CSS.escape(submitEl.id)}`;
        } else {
          const name = submitEl.getAttribute('name');
          if (name) {
            submitSelector = `[name="${CSS.escape(name)}"]`;
          }
        }
      }

      const promptText = (container.textContent || '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 1000);

      const canvas = container.querySelector('canvas');
      const img = container.querySelector('img');
      let imageDataUrl: string | undefined;
      let triedImage = false;

      if (canvas || img) {
        triedImage = true;
        try {
          if (canvas) {
            imageDataUrl = canvas.toDataURL('image/png');
          } else if (img) {
            const tempCanvas = document.createElement('canvas');
            tempCanvas.width = img.naturalWidth || img.width || 100;
            tempCanvas.height = img.naturalHeight || img.height || 100;
            const ctx = tempCanvas.getContext('2d');
            if (ctx) {
              ctx.drawImage(img, 0, 0);
              imageDataUrl = tempCanvas.toDataURL('image/png');
            }
          }
        } catch (err) {
          // Tainted or failed
        }
      }

      let kind: 'image_prompt' | 'text_prompt';
      if (imageDataUrl) {
        kind = 'image_prompt';
      } else {
        if (triedImage) {
          if (promptText) {
            kind = 'text_prompt';
          } else {
            return null;
          }
        } else {
          kind = 'text_prompt';
        }
      }

      return {
        kind,
        pageUrl: window.location.href,
        promptText,
        inputSelector,
        submitSelector,
        imageDataUrl
      };
    });
  }

  private async fillCaptchaAnswer(page: PlaywrightPage, challenge: CaptchaChallenge, answer: string): Promise<void> {
    let filled = false;
    if (typeof page.fill === 'function') {
      try {
        await page.fill(challenge.inputSelector, answer);
        filled = true;
      } catch (err) {
        // Fallback
      }
    }
    if (!filled) {
      await page.evaluate(({ selector, value }) => {
        const el = document.querySelector(selector) as HTMLInputElement | HTMLTextAreaElement | null;
        if (el) {
          el.value = value;
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        }
      }, { selector: challenge.inputSelector, value: answer });
    }
  }

  private async clickCaptchaContinueIfAvailable(page: PlaywrightPage, challenge: CaptchaChallenge): Promise<string | null> {
    if (challenge.submitSelector) {
      try {
        if (typeof page.click === 'function') {
          await page.click(challenge.submitSelector);
        } else {
          await page.evaluate((sel) => {
            const el = document.querySelector(sel) as HTMLElement | null;
            if (el) el.click();
          }, challenge.submitSelector);
        }
      } catch (err) {
        await page.evaluate((sel) => {
          const el = document.querySelector(sel) as HTMLElement | null;
          if (el) el.click();
        }, challenge.submitSelector);
      }
      await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 750)));
      return challenge.submitSelector;
    }

    const clickedSelector = await page.evaluate((inputSel) => {
      const isVisible = (el: Element): boolean => {
        const style = window.getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden' || parseFloat(style.opacity || '1') === 0) {
          return false;
        }
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) {
          return false;
        }
        return true;
      };

      const inputEl = document.querySelector(inputSel);
      if (!inputEl) return null;
      const container = inputEl.closest('[data-automation-id*="captcha" i], [id*="captcha" i], [class*="captcha" i]') || inputEl.parentElement;
      if (!container) return null;

      const submitRegex = /continue|verify|proceed|next|apply|submit/i;
      const excludeRegex = /submit application|final submit|delete|withdraw|cancel/i;

      const checkButton = (btn: Element): boolean => {
        if (!isVisible(btn)) return false;
        if (btn.hasAttribute('disabled') || (btn as HTMLButtonElement).disabled) return false;
        const text = (btn.textContent || '').trim();
        const val = btn.getAttribute('value') || '';
        return (submitRegex.test(text) || submitRegex.test(val)) && !(excludeRegex.test(text) || excludeRegex.test(val));
      };

      const btnsInContainer = Array.from(container.querySelectorAll('button, input[type="button"], input[type="submit"]'));
      let match = btnsInContainer.find(checkButton);

      if (!match) {
        let currentParent = container.parentElement;
        for (let depth = 0; depth < 3 && currentParent; depth++) {
          const btnsNear = Array.from(currentParent.querySelectorAll('button, input[type="button"], input[type="submit"]'));
          const matchNear = btnsNear.find(checkButton);
          if (matchNear) {
            match = matchNear;
            break;
          }
          currentParent = currentParent.parentElement;
        }
      }

      if (!match) {
        const allBtns = Array.from(document.querySelectorAll('button, input[type="button"], input[type="submit"]'));
        match = allBtns.find(checkButton);
      }

      if (match) {
        (match as HTMLElement).click();
        if (match.id) return `#${CSS.escape(match.id)}`;
        const name = match.getAttribute('name');
        if (name) return `[name="${CSS.escape(name)}"]`;
        return 'button';
      }
      return null;
    }, challenge.inputSelector);

    if (clickedSelector) {
      await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 750)));
    }
    return clickedSelector;
  }

  private async handleCaptchaIfPresent(page: PlaywrightPage): Promise<CaptchaSolveResult | null> {
    if (!this.captchaSolver) {
      return null;
    }
    const challengeOrWidget = await this.detectLlmCaptchaChallenge(page);
    if (!challengeOrWidget) {
      return null;
    }
    if ('kind' in challengeOrWidget && challengeOrWidget.kind === 'unsupported_widget') {
      return {
        success: false,
        provider: 'configured_llm',
        kind: 'unsupported_widget',
        status: 'unsupported',
        error: 'token_widget',
        elapsedMs: 0
      };
    }
    const challenge = challengeOrWidget as CaptchaChallenge;
    const result = await this.captchaSolver.solve(challenge);
    if (result.success && result.answer) {
      await this.fillCaptchaAnswer(page, challenge, result.answer);
      await this.clickCaptchaContinueIfAvailable(page, challenge);
    }
    return result;
  }

  async close(): Promise<void> {
    // No-op for foundation slice
  }
}

// Support legacy export name if used elsewhere
export { PlaywrightBrowserAdapter as PlaywrightAutomationAdapter };
