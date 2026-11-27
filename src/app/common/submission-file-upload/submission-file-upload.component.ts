import {HttpClient, HttpErrorResponse, HttpEventType, HttpResponse} from '@angular/common/http';
import {
  ChangeDetectionStrategy,
  Component,
  EventEmitter,
  Input,
  OnChanges,
  OnDestroy,
  OnInit,
  Output,
  SimpleChanges,
} from '@angular/core';
import {MatDialog} from '@angular/material/dialog';
import {Subscription} from 'rxjs';
import {ACCEPTED_TYPES, FileUploadSpec} from 'src/app/common/file-uploader/file-uploader.component';
import {DoubtfireConstants} from 'src/app/config/constants/doubtfire-constants';
import {SubmissionRequestDeniedModalComponent} from 'src/app/tasks/modals/submission-request-denied-modal/submission-request-denied-modal.component';

type AcceptedTypeKey = keyof typeof ACCEPTED_TYPES;

export type SubmissionFileThumbnail = 'image' | 'pdf' | 'badge' | 'empty';

export interface SubmissionFileRow {
  key: string;
  name: string;
  typeLabel: string;
  icon: string;
  accept: string;
  extensions: readonly string[];
  file: File | null;
  previewUrl: string | null;
  invalid: boolean;
  dragOver: boolean;
}

interface UploadingInfo {
  progress: number;
  success: boolean | null;
  error: string | null;
  complete: boolean;
}

const INVALID_FILE_MESSAGE_MS = 5000;

/**
 * Lets a student choose one file per upload requirement, each in its own row and drop zone,
 * then sends all files together in one request (the same request the old file uploader makes).
 */
@Component({
  selector: 'f-submission-file-upload',
  templateUrl: './submission-file-upload.component.html',
  changeDetection: ChangeDetectionStrategy.Eager,
  standalone: false,
})
export class SubmissionFileUploadComponent implements OnInit, OnChanges, OnDestroy {
  @Input() files: FileUploadSpec;
  @Input() url: string;
  @Input() payload?: unknown;

  @Input() onBeforeUpload?: () => void;
  @Input() onSuccess?: (response) => void;
  @Input() onFailure?: (response) => void;
  @Input() onRequestDenied?: (supportId: string) => void;
  @Input() onComplete?: () => void;
  @Input() onClickFailureCancel?: () => void;

  @Output() isReadyChange: EventEmitter<boolean> = new EventEmitter();
  @Output() uploadReady: EventEmitter<() => void> = new EventEmitter();

  public rows: SubmissionFileRow[] = [];
  public isUploading = false;
  public uploadingInfo: UploadingInfo | null = null;

  private uploadRequestedAt: Date | null = null;
  private externalName = 'OnTrack';
  private externalNameSubscription?: Subscription;
  private invalidTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();

  constructor(
    private httpClient: HttpClient,
    private constants: DoubtfireConstants,
    private dialog: MatDialog,
  ) {}

  ngOnInit(): void {
    this.createRows(this.files);
    this.uploadReady.emit(this.startUpload.bind(this));
    this.emitReadyState();

    this.externalNameSubscription = this.constants.ExternalName.subscribe((name) => {
      this.externalName = name;
    });
  }

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['files'] && !changes['files'].firstChange) {
      this.createRows(changes['files'].currentValue);
      this.emitReadyState();
    }
  }

  ngOnDestroy(): void {
    this.externalNameSubscription?.unsubscribe();
    this.invalidTimers.forEach((timer) => clearTimeout(timer));
    this.invalidTimers.clear();
    this.rows.forEach((row) => this.revokePreview(row));
  }

  public get selectedCount(): number {
    return this.rows.filter((row) => row.file).length;
  }

  public get isReady(): boolean {
    return this.rows.length > 0 && this.rows.every((row) => row.file);
  }

  public onDragOver(event: DragEvent, row: SubmissionFileRow): void {
    event.preventDefault();
    event.stopPropagation();
    if (!this.isUploading) {
      row.dragOver = true;
    }
  }

  public onDragLeave(event: DragEvent, row: SubmissionFileRow): void {
    event.preventDefault();
    event.stopPropagation();

    // Moving over the row's own children also fires dragleave; only clear when leaving the row.
    const rowElement = event.currentTarget as Node | null;
    if (rowElement && event.relatedTarget && rowElement.contains(event.relatedTarget as Node)) {
      return;
    }
    row.dragOver = false;
  }

  public onFileDropped(event: DragEvent, row: SubmissionFileRow): void {
    event.preventDefault();
    event.stopPropagation();
    row.dragOver = false;

    const file = event.dataTransfer?.files?.[0];
    if (file && !this.isUploading) {
      this.setFile(row, file);
    }
  }

  public onFileSelected(event: Event, row: SubmissionFileRow): void {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (file) {
      this.setFile(row, file);
    }
    input.value = '';
  }

  public setFile(row: SubmissionFileRow, file: File): void {
    if (!this.isAcceptedFile(row, file)) {
      this.showInvalidFile(row);
      return;
    }

    this.clearInvalidFile(row);
    this.revokePreview(row);
    row.file = file;
    row.previewUrl = this.isImageFile(file) ? URL.createObjectURL(file) : null;
    this.emitReadyState();
  }

  public removeFile(row: SubmissionFileRow): void {
    this.revokePreview(row);
    row.file = null;
    this.emitReadyState();
  }

  public clearAll(): void {
    this.rows.forEach((row) => {
      this.revokePreview(row);
      row.file = null;
    });
    this.emitReadyState();
  }

  public onPreviewError(row: SubmissionFileRow): void {
    // Some image types (e.g. TIFF) can't be shown by the browser, so fall back to the badge.
    this.revokePreview(row);
  }

  public thumbnailFor(row: SubmissionFileRow): SubmissionFileThumbnail {
    if (!row.file) {
      return 'empty';
    }
    if (row.previewUrl) {
      return 'image';
    }
    if (this.extensionOf(row.file.name) === 'pdf') {
      return 'pdf';
    }
    return 'badge';
  }

  public extensionLabel(file: File): string {
    return this.extensionOf(file.name) || 'file';
  }

  public dropHint(row: SubmissionFileRow): string {
    const article = /^[aeiou]/i.test(row.typeLabel) ? 'an' : 'a';
    return `Drop ${article} ${row.typeLabel} file here or click to choose`;
  }

  public acceptedList(row: SubmissionFileRow): string {
    return row.extensions.map((ext) => `.${ext}`).join(', ');
  }

  public formatSize(bytes: number): string {
    if (bytes < 1024) {
      return `${bytes} B`;
    }
    if (bytes < 1024 * 1024) {
      return `${(bytes / 1024).toFixed(1)} KB`;
    }
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  public startUpload(): void {
    if (!this.isReady || this.isUploading) {
      return;
    }

    this.onBeforeUpload?.();
    this.uploadRequestedAt = new Date();
    this.uploadingInfo = {progress: 5, success: null, error: null, complete: false};
    this.isUploading = true;

    const form = new FormData();
    for (const row of this.rows) {
      if (row.file) {
        form.append(row.key, row.file);
      }
    }

    if (this.payload) {
      for (const [key, value] of Object.entries(this.payload)) {
        form.append(key, typeof value === 'object' ? JSON.stringify(value) : value);
      }
    }

    this.httpClient
      .request('POST', this.url, {
        body: form,
        observe: 'events',
        reportProgress: true,
        responseType: 'text',
      })
      .subscribe({
        next: (event) => {
          if (event.type === HttpEventType.UploadProgress && event.total) {
            this.uploadingInfo.progress = Math.floor((event.loaded / event.total) * 100);
          } else if (event instanceof HttpResponse) {
            this.handleUploadResponse(event.status, event.body);
          }
        },
        error: (error: unknown) => {
          if (error instanceof HttpErrorResponse) {
            this.handleUploadResponse(error.status, error.error);
          } else {
            // Interceptors may propagate an extracted API error rather than the
            // original HttpErrorResponse.
            this.handleUploadResponse(-1, error);
          }
        },
      });
  }

  public retryUpload(): void {
    this.isUploading = false;
    this.uploadingInfo = null;
    this.startUpload();
  }

  public cancelAfterFailure(): void {
    if (this.onClickFailureCancel) {
      this.onClickFailureCancel();
      return;
    }

    this.isUploading = false;
    this.uploadingInfo = null;
  }

  private createRows(files: FileUploadSpec | undefined): void {
    this.rows.forEach((row) => this.revokePreview(row));

    this.rows = Object.entries(files ?? {}).map(([key, requirement]) => {
      const typeKey = (
        requirement.type === 'archive' ? 'zip' : requirement.type
      ) as AcceptedTypeKey;
      const typeData = ACCEPTED_TYPES[typeKey];
      if (!typeData) {
        throw new Error(`Invalid type provided to Submission File Upload ${requirement.type}`);
      }

      return {
        key,
        name: requirement.name,
        typeLabel: typeData.name,
        icon: typeData.icon,
        accept: `.${typeData.extensions.join(',.')}`,
        extensions: typeData.extensions,
        file: null,
        previewUrl: null,
        invalid: false,
        dragOver: false,
      };
    });
  }

  private isAcceptedFile(row: SubmissionFileRow, file: File): boolean {
    const name = file.name.toLowerCase();
    return row.extensions.some((ext) => name.endsWith(`.${ext.toLowerCase()}`));
  }

  private isImageFile(file: File): boolean {
    return ACCEPTED_TYPES.image.extensions.some((ext) => ext === this.extensionOf(file.name));
  }

  private extensionOf(fileName: string): string {
    const dot = fileName.lastIndexOf('.');
    return dot >= 0 ? fileName.slice(dot + 1).toLowerCase() : '';
  }

  private showInvalidFile(row: SubmissionFileRow): void {
    this.clearInvalidFile(row);
    row.invalid = true;
    this.invalidTimers.set(
      row.key,
      setTimeout(() => {
        row.invalid = false;
        this.invalidTimers.delete(row.key);
      }, INVALID_FILE_MESSAGE_MS),
    );
  }

  private clearInvalidFile(row: SubmissionFileRow): void {
    const timer = this.invalidTimers.get(row.key);
    if (timer) {
      clearTimeout(timer);
      this.invalidTimers.delete(row.key);
    }
    row.invalid = false;
  }

  private revokePreview(row: SubmissionFileRow): void {
    if (row.previewUrl) {
      URL.revokeObjectURL(row.previewUrl);
      row.previewUrl = null;
    }
  }

  private emitReadyState(): void {
    this.isReadyChange.emit(this.isReady);
  }

  private handleUploadResponse(status: number, responseBody: unknown): void {
    setTimeout(() => {
      this.uploadingInfo.complete = true;
      const response = this.parseUploadResponse(status, responseBody);
      const supportId = this.extractWafSupportId(response);

      if (supportId) {
        this.uploadingInfo.success = false;
        this.uploadingInfo.error =
          'A network security service blocked the upload. Copy the support ID from the dialog and contact your tutor or support team.';
        if (this.onRequestDenied) {
          this.onRequestDenied(supportId);
        } else {
          this.dialog.open(SubmissionRequestDeniedModalComponent, {
            autoFocus: false,
            width: '100%',
            maxWidth: '640px',
            data: {
              requestedAt: this.uploadRequestedAt ?? new Date(),
              supportId,
            },
          });
        }
        return;
      }

      if (status >= 200 && status < 300 && typeof response !== 'string') {
        this.onSuccess?.(response);
        this.uploadingInfo.success = true;
        setTimeout(() => {
          this.onComplete?.();
        }, 2500);
      } else {
        this.onFailure?.(response);
        this.uploadingInfo.success = false;
        this.uploadingInfo.error =
          status >= 200 && status < 300
            ? 'The server returned an invalid upload response. Please try again.'
            : this.extractUploadError(response);
      }
    }, 2000);
  }

  private parseUploadResponse(status: number, responseBody: unknown): unknown {
    if (status === 0) {
      return {error: `Could not connect to the ${this.externalName} server`};
    }

    if (typeof responseBody !== 'string') {
      return responseBody;
    }

    try {
      return JSON.parse(responseBody);
    } catch {
      return responseBody;
    }
  }

  private extractWafSupportId(response: unknown): string | null {
    if (
      typeof response !== 'string' ||
      !/Request Rejected/i.test(response) ||
      !/requested URL was rejected/i.test(response)
    ) {
      return null;
    }

    return response.match(/Your support ID is\s*([^<\r\n]+)/i)?.[1]?.trim() || null;
  }

  private extractUploadError(response: unknown): string {
    if (typeof response === 'string') {
      return response;
    }

    if (response && typeof response === 'object' && 'error' in response) {
      return String(response.error);
    }

    return 'Unknown error';
  }
}
