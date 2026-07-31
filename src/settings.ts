import { FuzzySuggestModal, Notice, Plugin, PluginSettingTab, Setting, TFile, TFolder } from "obsidian";
import { DEFAULT_SETTINGS, mergeSettings, type PluginSettings } from "./model";

export { mergeSettings, DEFAULT_SETTINGS };

export interface SettingsHost {
  inkSettings: PluginSettings;
  saveSettings(settings: PluginSettings): Promise<void>;
  readAllLogs(): Promise<string | null>;
}

type ImperativeSettingDefinition =
  | {
    type: "group";
    heading: string;
    items: readonly ImperativeSettingDefinition[];
  }
  | {
    name?: string;
    desc?: string;
    searchable?: boolean;
    render?: (setting: Setting) => void;
  };

/** Vault-only picker used for paths that must never escape the current vault. */
class FolderPicker extends FuzzySuggestModal<string> {
  constructor(
    app: ConstructorParameters<typeof PluginSettingTab>[0],
    private readonly folders: readonly string[],
    private readonly onChoose: (path: string) => void
  ) {
    super(app);
    this.setPlaceholder("Choose a vault folder");
  }

  getItems(): string[] {
    return [...this.folders];
  }

  getItemText(path: string): string {
    return path || "Vault root";
  }

  onChooseItem(path: string): void {
    this.onChoose(path);
  }
}

/** Vault-only PDF picker for the optional handwritten-note template. */
class PdfPicker extends FuzzySuggestModal<TFile> {
  constructor(
    app: ConstructorParameters<typeof PluginSettingTab>[0],
    private readonly onChoose: (file: TFile) => void
  ) {
    super(app);
    this.setPlaceholder("Choose a PDF template");
  }

  getItems(): TFile[] {
    return this.app.vault.getFiles().filter((file) => file.extension.toLowerCase() === "pdf");
  }

  getItemText(file: TFile): string {
    return file.path;
  }

  onChooseItem(file: TFile): void {
    this.onChoose(file);
  }
}

export class NativePdfInkSettingTab extends PluginSettingTab {
  constructor(app: ConstructorParameters<typeof PluginSettingTab>[0], private readonly host: Plugin & SettingsHost) {
    super(app, host);
  }

  /**
   * Obsidian ≤1.12 opens settings through `display()`. 1.13+ prefers
   * {@link getSettingDefinitions} and ignores this method when that API exists.
   * Keep both so the tab is not blank on current stable (1.12.x).
   */
  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    this.renderSettingDefinitions(containerEl, this.getSettingDefinitions());
  }

  /**
   * Obsidian 1.13+ settings search + declarative render. Uses `render` (not
   * `control.key`) so changes still go through {@link persistPatch} / host
   * `saveSettings` (toolbar remount + boosted zoom).
   */
  getSettingDefinitions() {
    return [
      {
        name: "About",
        desc: "PDF handwriting for a stylus or mouse. Ink remains editable in a sidecar; Add page updates the PDF itself.",
        searchable: false
      },
      {
        name: "Autosave",
        desc: "Save completed edits automatically. Enabled by default.",
        render: (setting: Setting) => {
          setting.addToggle((toggle) =>
            toggle.setValue(this.host.inkSettings.autosave).onChange(async (value) => {
              await this.persistPatch({ autosave: value });
            })
          );
        }
      },
      {
        name: "Autosave delay",
        desc: "Wait 100–60,000 milliseconds after an edit before saving the sidecar.",
        render: (setting: Setting) => {
          this.addDelayInput(setting, {
            descriptionId: "native-pdf-handwriting-autosave-delay-description",
            value: this.host.inkSettings.autosaveDelayMs,
            min: 100,
            max: 60_000,
            persist: async (autosaveDelayMs) => this.persistPatch({ autosaveDelayMs })
          });
        }
      },
      {
        name: "Save when closing a PDF",
        desc: "Flush pending autosaves before a PDF view closes.",
        render: (setting: Setting) => {
          setting.addToggle((toggle) =>
            toggle.setValue(this.host.inkSettings.saveWhenClosing).onChange(async (value) => {
              await this.persistPatch({ saveWhenClosing: value });
            })
          );
        }
      },
      {
        name: "Show save-status indicator",
        desc: "Show whether the current PDF is saved, saving, or needs attention.",
        render: (setting: Setting) => {
          setting.addToggle((toggle) =>
            toggle.setValue(this.host.inkSettings.showSaveStatus).onChange(async (value) => {
              await this.persistPatch({ showSaveStatus: value });
            })
          );
        }
      },
      {
        type: "group" as const,
        heading: "PDF navigation",
        items: [
          {
            name: "Drag to scroll when draw mode is off",
            desc: "Vertical mouse drag on empty PDF areas scrolls the document. Text selection and links still work normally.",
            render: (setting: Setting) => {
              setting.addToggle((toggle) =>
                toggle.setValue(this.host.inkSettings.mouseDragScroll).onChange(async (value) => {
                  await this.persistPatch({ mouseDragScroll: value });
                })
              );
            }
          },
          {
            name: "Ink toolbar placement",
            desc: "Put the ink controls on the PDF toolbar, or as a left/right sidebar beside the pages. On mobile, PDF toolbar placement becomes the left sidebar automatically.",
            render: (setting: Setting) => {
              setting.addDropdown((dropdown) =>
                dropdown
                  .addOption("main", "PDF toolbar (default; left sidebar on mobile)")
                  .addOption("left", "Left sidebar")
                  .addOption("right", "Right sidebar")
                  .setValue(this.host.inkSettings.toolbarPlacement)
                  .onChange(async (value) => {
                    if (value === "main" || value === "left" || value === "right") {
                      await this.persistPatch({ toolbarPlacement: value });
                    }
                  })
              );
            }
          }
        ]
      },
      {
        type: "group" as const,
        heading: "Drawing",
        items: [
          {
            name: "Touch drawing",
            desc: "With Draw on, one finger draws, erases, lassos, or places text. Turn Draw off to scroll or pinch the PDF."
          },
          {
            name: "Input pressure profile",
            desc: "Auto uses real stylus pressure and steady mouse/finger ink. Choose Pen to force stylus pressure, or Mouse for a steady pressure-independent stroke.",
            render: (setting: Setting) => {
              setting.addDropdown((dropdown) =>
                dropdown
                  .addOption("auto", "Auto (recommended)")
                  .addOption("pen", "Pen")
                  .addOption("mouse", "Mouse")
                  .setValue(this.host.inkSettings.pressureProfile)
                  .onChange(async (value) => {
                    if (value === "auto" || value === "pen" || value === "mouse") {
                      await this.persistPatch({ pressureProfile: value });
                    }
                  })
              );
            }
          },
          {
            name: "Pressure calibration",
            searchable: false,
            render: (setting: Setting) => this.renderPressureCalibration(setting)
          },
          {
            name: "Simplify strokes on release",
            desc: "Snap finished ink to cleaner straight segments. Off keeps the exact path you drew.",
            render: (setting: Setting) => {
              setting.addToggle((toggle) =>
                toggle.setValue(this.host.inkSettings.simplifyStrokes).onChange(async (value) => {
                  await this.persistPatch({ simplifyStrokes: value });
                })
              );
            }
          },
          {
            name: "Retry failed autosaves",
            desc: "Try saving again after an automatic save fails.",
            render: (setting: Setting) => {
              setting.addToggle((toggle) =>
                toggle.setValue(this.host.inkSettings.retryFailedAutosaves).onChange(async (value) => {
                  await this.persistPatch({ retryFailedAutosaves: value });
                })
              );
            }
          }
        ]
      },
      {
        type: "group" as const,
        heading: "Storage",
        items: [
          {
            name: "Annotation sidecar folder",
            desc: "Vault-relative folder for editable annotation JSON. Ink stays editable here while Add page updates the PDF itself.",
            render: (setting: Setting) => {
              this.addFolderPathInput(setting, {
                value: this.host.inkSettings.sidecarFolder,
                persist: async (sidecarFolder) => this.persistPatch({ sidecarFolder })
              });
            }
          },
          {
            name: "PDF template",
            desc: "Vault-relative PDF used for new handwritten notes. Only its first page is used; leave empty for blank US Letter paper.",
            render: (setting: Setting) => {
              this.addPdfPathInput(setting, {
                value: this.host.inkSettings.pdfTemplatePath,
                persist: async (pdfTemplatePath) => this.persistPatch({ pdfTemplatePath })
              });
            }
          }
        ]
      },
      {
        name: "Advanced settings",
        searchable: false,
        render: (setting: Setting) => this.renderAdvancedSettingsDropdown(setting)
      },
      {
        name: "Support",
        searchable: false,
        render: (setting: Setting) => {
          const supportLinks = setting.controlEl.createDiv({ cls: "native-pdf-handwriting-support-links" });
          supportLinks.createEl("a", {
            cls: "native-pdf-handwriting-support-link",
            text: "Report bug",
            attr: {
              href: "https://github.com/MarsLuay/handwriting-natively/issues",
              rel: "noopener noreferrer",
              target: "_blank"
            }
          });
          supportLinks.createEl("a", {
            cls: "native-pdf-handwriting-support-link",
            text: "Buy me a coffee",
            attr: {
              href: "https://buymeacoffee.com/marwanluaye",
              rel: "noopener noreferrer",
              target: "_blank"
            }
          });
        }
      }
    ];
  }

  private renderSettingDefinitions(
    containerEl: HTMLElement,
    definitions: readonly ImperativeSettingDefinition[]
  ): void {
    for (const definition of definitions) {
      if (definition && typeof definition === "object" && "type" in definition && definition.type === "group") {
        new Setting(containerEl).setName(definition.heading).setHeading();
        this.renderSettingDefinitions(containerEl, definition.items);
        continue;
      }
      const setting = new Setting(containerEl);
      if ("name" in definition && definition.name) setting.setName(definition.name);
      if ("desc" in definition && definition.desc) setting.setDesc(definition.desc);
      if ("render" in definition && typeof definition.render === "function") {
        definition.render(setting);
      }
    }
  }

  private renderAdvancedSettingsDropdown(setting: Setting): void {
    const contents = this.replaceSettingWithDetails(setting, {
      summary: "Advanced settings",
      detailsClass: "native-pdf-handwriting-advanced-settings-details",
      contentsClass: "native-pdf-handwriting-advanced-settings-contents"
    });

    new Setting(contents)
      .setName("Allow 25× PDF zoom")
      .setDesc("Increase the PDF viewer zoom limit beyond Obsidian's normal 10× cap. This can use substantially more memory on large pdfs.")
      .addToggle((toggle) =>
        toggle.setValue(this.host.inkSettings.boostedPdfZoom).onChange(async (value) => {
          await this.persistPatch({ boostedPdfZoom: value });
        })
      );

    new Setting(contents)
      .setName("Hide stylus annotation label")
      .setDesc("Remove the invisible page label announced to screen readers when the annotation canvas is focused.")
      .addToggle((toggle) =>
        toggle.setValue(this.host.inkSettings.hideStylusAnnotationLabel).onChange(async (value) => {
          await this.persistPatch({ hideStylusAnnotationLabel: value });
        })
      );

    new Setting(contents)
      .setName("Vault debug log")
      .setDesc("Append every plugin event to a line-delimited log file in the vault so agents can read it directly. Off by default. Includes left-toolbar PDF sidebar offset diagnostics (reason, rects, jumps).")
      .addToggle((toggle) =>
        toggle.setValue(this.host.inkSettings.vaultDebugLog).onChange(async (value) => {
          await this.persistPatch({ vaultDebugLog: value });
        })
      );

    const logPath = new Setting(contents)
      .setName("Vault debug log path")
      .setDesc("Vault-relative location for the optional debug log (Markdown note). One JSON object per line.");
    this.addFolderPathInput(logPath, {
      value: this.host.inkSettings.vaultDebugLogPath,
      persist: async (vaultDebugLogPath) => this.persistPatch({ vaultDebugLogPath }),
      fileName: "debug.md"
    });

    new Setting(contents)
      .setName("Copy all logs")
      .setDesc("Copy the complete vault debug log. Enable vault debug log and reproduce an issue first to capture new events.")
      .addButton((button) =>
        button.setButtonText("Copy logs").onClick(async () => {
          try {
            const logs = await this.host.readAllLogs();
            if (!logs) {
              new Notice("No vault debug logs are available. Enable vault debug log and reproduce the issue first.");
              return;
            }
            await navigator.clipboard.writeText(logs);
            new Notice("All debug logs copied.");
          } catch (error) {
            console.error("Handwriting Natively could not copy logs", error);
            new Notice("Could not copy logs. Check clipboard permission and try again.");
          }
        })
      );
  }

  private renderPressureCalibration(setting: Setting): void {
    const contents = this.replaceSettingWithDetails(setting, {
      summary: "Pressure calibration",
      detailsClass: "native-pdf-handwriting-pressure-calibration",
      contentsClass: "native-pdf-handwriting-pressure-calibration-contents"
    });
    contents.createEl("p", {
      cls: "native-pdf-handwriting-settings-details-desc",
      text: "Tune how new pen and auto strokes start and respond. Mouse profile remains steady. Draw a few strokes after changing a control; only strokes started afterwards are affected."
    });
    const calibration = { ...this.host.inkSettings.pressureCalibration };
    const syncControls: Array<() => void> = [];
    const fields = [
      ["Start pressure", "Keeps the beginning of a light pen stroke visible.", "initialFloor", 0, 0.3, 0.01, (value: number) => `${Math.round(value * 100)}%`],
      ["Response", "Raises or lowers the pen-pressure response.", "gain", 0.4, 2, 0.05, (value: number) => `${value.toFixed(2)}×`],
      ["Smoothing", "Higher values remove small pressure flicker.", "smoothing", 0, 1, 0.01, (value: number) => `${Math.round(value * 100)}%`]
    ] as const;
    for (const [name, desc, key, min, max, step, format] of fields) {
      const control = new Setting(contents)
        .setName(`${name} (${format(calibration[key])})`)
        .setDesc(desc)
      let sync: () => void = () => undefined;
      control.addSlider((slider) => {
        sync = () => {
          control.setName(`${name} (${format(calibration[key])})`);
          slider.setValue(calibration[key]);
        };
        return slider
          .setLimits(min, max, step)
          .setInstant(true)
          .setValue(calibration[key])
          .onChange(async (value) => {
            calibration[key] = value;
            await this.persistPatch({ pressureCalibration: { ...calibration } });
          });
      });
      syncControls.push(sync);
    }
    new Setting(contents)
      .setName("Reset calibration")
      .setDesc("Restore the balanced default response.")
      .addButton((button) => button.setButtonText("Reset").onClick(async () => {
        Object.assign(calibration, DEFAULT_SETTINGS.pressureCalibration);
        await this.persistPatch({ pressureCalibration: { ...calibration } });
        syncControls.forEach((sync) => sync());
      }));
  }

  /**
   * Obsidian Setting rows are flex (info | control). Collapsible sections need a
   * full-width block host — gutting the row without resetting layout compresses
   * the summary and nested settings.
   */
  private replaceSettingWithDetails(
    setting: Setting,
    options: {
      summary: string;
      detailsClass: string;
      contentsClass: string;
    }
  ): HTMLElement {
    setting.settingEl.empty();
    setting.settingEl.addClass("native-pdf-handwriting-settings-details-host");
    const details = setting.settingEl.createEl("details", {
      cls: options.detailsClass
    });
    details.createEl("summary", { text: options.summary });
    return details.createDiv({ cls: options.contentsClass });
  }

  private addDelayInput(
    setting: Setting,
    options: {
      descriptionId: string;
      value: number;
      min: number;
      max: number;
      persist: (value: number) => Promise<void>;
    }
  ): void {
    setting.descEl.id = options.descriptionId;
    setting.addText((text) => {
      const readValidDelay = (value: string): number | null => {
        const delay = Number(value);
        const valid = Number.isFinite(delay) && delay >= options.min && delay <= options.max;
        text.inputEl.setAttribute("aria-invalid", String(!valid));
        return valid ? Math.round(delay) : null;
      };
      text.inputEl.setAttribute("aria-describedby", options.descriptionId);
      text.inputEl.setAttribute("inputmode", "numeric");
      text.setValue(String(options.value));
      readValidDelay(String(options.value));
      text.onChange(async (value) => {
        const delay = readValidDelay(value);
        if (delay !== null) await options.persist(delay);
      });
    });
  }

  private addFolderPathInput(
    setting: Setting,
    options: {
      value: string;
      persist: (value: string) => Promise<void>;
      fileName?: string;
    }
  ): void {
    let input: HTMLInputElement | null = null;
    setting.addText((text) => {
      input = text.inputEl;
      text.setValue(options.value).onChange(async (value) => {
        await options.persist(value.trim());
      });
    });
    setting.addExtraButton((button) =>
      button.setIcon("search").setTooltip("Choose vault folder").onClick(() => {
        new FolderPicker(this.app, this.vaultFolders(), (folder) => {
          const selected = options.fileName
            ? folder ? `${folder}/${options.fileName}` : options.fileName
            : folder;
          if (input) input.value = selected;
          void options.persist(selected);
        }).open();
      })
    );
  }

  private addPdfPathInput(
    setting: Setting,
    options: { value: string; persist: (value: string) => Promise<void> }
  ): void {
    let input: HTMLInputElement | null = null;
    setting.addText((text) => {
      input = text.inputEl;
      text.setPlaceholder("Blank us letter paper").setValue(options.value).onChange(async (value) => {
        await options.persist(value.trim());
      });
    });
    setting.addExtraButton((button) =>
      button.setIcon("search").setTooltip("Choose vault PDF").onClick(() => {
        new PdfPicker(this.app, (file) => {
          if (input) input.value = file.path;
          void options.persist(file.path);
        }).open();
      })
    );
  }

  private vaultFolders(): string[] {
    const folders = this.app.vault.getAllLoadedFiles()
      .filter((file): file is TFolder => file instanceof TFolder)
      .map((folder) => folder.path);
    return ["", ...folders].sort((left, right) => left.localeCompare(right));
  }

  private async persistPatch(patch: Partial<PluginSettings>): Promise<void> {
    // Do not assign host.inkSettings before saveSettings — it compares previous placement to remount open PDFs.
    await this.host.saveSettings({ ...this.host.inkSettings, ...patch });
  }
}
