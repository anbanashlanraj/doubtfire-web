import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {HttpClient, provideHttpClient} from '@angular/common/http';
import {HttpTestingController, provideHttpClientTesting} from '@angular/common/http/testing';
import {TestBed} from '@angular/core/testing';
import {MatDialog} from '@angular/material/dialog';
import {BehaviorSubject} from 'rxjs';
import {DoubtfireConstants} from 'src/app/config/constants/doubtfire-constants';
import {SubmissionFileUploadComponent} from './submission-file-upload.component';

const UPLOAD_URL = 'http://localhost/api/projects/1/task_def_id/2/submission';

function makeFile(name: string, content = 'content'): File {
  return new File([content], name);
}

describe('SubmissionFileUploadComponent', () => {
  let httpMock: HttpTestingController;
  let component: SubmissionFileUploadComponent;
  let readyStates: boolean[];

  beforeEach(() => {
    vi.useFakeTimers();
    URL.createObjectURL = vi.fn(() => 'blob:preview');
    URL.revokeObjectURL = vi.fn();

    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        {provide: MatDialog, useValue: {open: vi.fn()}},
        {
          provide: DoubtfireConstants,
          useValue: {ExternalName: new BehaviorSubject('OnTrack')},
        },
      ],
    });

    httpMock = TestBed.inject(HttpTestingController);
    component = new SubmissionFileUploadComponent(
      TestBed.inject(HttpClient),
      TestBed.inject(DoubtfireConstants),
      TestBed.inject(MatDialog),
    );
    component.files = {
      file0: {name: 'Worksheet', type: 'document'},
      file1: {name: 'list.cpp', type: 'code'},
      file2: {name: 'Study Notes', type: 'image'},
    };
    component.url = UPLOAD_URL;

    readyStates = [];
    component.isReadyChange.subscribe((ready) => readyStates.push(ready));
    component.ngOnInit();
  });

  afterEach(() => {
    component.ngOnDestroy();
    httpMock.verify();
    vi.useRealTimers();
  });

  it('creates one row per upload requirement, in order', () => {
    expect(component.rows.map((row) => row.key)).toEqual(['file0', 'file1', 'file2']);
    expect(component.rows.map((row) => row.name)).toEqual(['Worksheet', 'list.cpp', 'Study Notes']);
    expect(component.rows[0].accept).toBe('.pdf,.ps,.docx');
    expect(component.selectedCount).toBe(0);
    expect(readyStates).toEqual([false]);
  });

  it('uses the right article in the drop hint', () => {
    expect(component.dropHint(component.rows[0])).toBe('Drop a PDF file here or click to choose');
    expect(component.dropHint(component.rows[2])).toBe(
      'Drop an image file here or click to choose',
    );
  });

  it('rejects a file with the wrong extension and keeps the row empty', () => {
    const row = component.rows[0];

    component.setFile(row, makeFile('notes.txt'));

    expect(row.file).toBeNull();
    expect(row.invalid).toBe(true);

    vi.advanceTimersByTime(5000);
    expect(row.invalid).toBe(false);
  });

  it('keeps the previous file when a replacement is invalid', () => {
    const row = component.rows[0];
    const original = makeFile('worksheet.pdf');

    component.setFile(row, original);
    component.setFile(row, makeFile('worksheet.exe'));

    expect(row.file).toBe(original);
    expect(row.invalid).toBe(true);
  });

  it('only matches whole extensions', () => {
    const codeRow = component.rows[1];

    component.setFile(codeRow, makeFile('compiled.pyc'));

    expect(codeRow.file).toBeNull();
  });

  it('becomes ready once every row has a file, and not after one is removed', () => {
    component.setFile(component.rows[0], makeFile('worksheet.pdf'));
    component.setFile(component.rows[1], makeFile('list.cpp'));
    expect(component.isReady).toBe(false);

    component.setFile(component.rows[2], makeFile('notes.png'));
    expect(component.isReady).toBe(true);
    expect(readyStates.at(-1)).toBe(true);

    component.removeFile(component.rows[1]);
    expect(component.isReady).toBe(false);
    expect(readyStates.at(-1)).toBe(false);
  });

  it('shows image previews and releases them when cleared', () => {
    const imageRow = component.rows[2];

    component.setFile(imageRow, makeFile('notes.png'));
    expect(imageRow.previewUrl).toBe('blob:preview');
    expect(component.thumbnailFor(imageRow)).toBe('image');

    component.clearAll();
    expect(imageRow.file).toBeNull();
    expect(imageRow.previewUrl).toBeNull();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:preview');
    expect(component.selectedCount).toBe(0);
  });

  it('uses a PDF icon for PDFs and an extension badge for other files', () => {
    component.setFile(component.rows[0], makeFile('worksheet.pdf'));
    component.setFile(component.rows[1], makeFile('list.cpp'));

    expect(component.thumbnailFor(component.rows[0])).toBe('pdf');
    expect(component.thumbnailFor(component.rows[1])).toBe('badge');
    expect(component.extensionLabel(component.rows[1].file)).toBe('cpp');
  });

  it('sends every file and the payload in one request, then reports success', () => {
    const onBeforeUpload = vi.fn();
    const onSuccess = vi.fn();
    const onComplete = vi.fn();
    component.onBeforeUpload = onBeforeUpload;
    component.onSuccess = onSuccess;
    component.onComplete = onComplete;
    component.payload = {comment: 'Please check my tests', contributions: [{pts: 3}]};

    component.setFile(component.rows[0], makeFile('worksheet.pdf'));
    component.setFile(component.rows[1], makeFile('list.cpp'));
    component.setFile(component.rows[2], makeFile('notes.png'));
    component.startUpload();

    expect(onBeforeUpload).toHaveBeenCalled();
    expect(component.isUploading).toBe(true);

    const request = httpMock.expectOne(UPLOAD_URL);
    expect(request.request.method).toBe('POST');
    const body = request.request.body as FormData;
    expect((body.get('file0') as File).name).toBe('worksheet.pdf');
    expect((body.get('file1') as File).name).toBe('list.cpp');
    expect((body.get('file2') as File).name).toBe('notes.png');
    expect(body.get('comment')).toBe('Please check my tests');
    expect(body.get('contributions')).toBe('[{"pts":3}]');

    request.flush(JSON.stringify({id: 5, project_id: 1, status: 'ready_for_feedback'}));
    vi.advanceTimersByTime(2000);

    expect(onSuccess).toHaveBeenCalledWith({id: 5, project_id: 1, status: 'ready_for_feedback'});
    expect(component.uploadingInfo.success).toBe(true);

    vi.advanceTimersByTime(2500);
    expect(onComplete).toHaveBeenCalled();
  });

  it('does not upload until every row has a file', () => {
    component.setFile(component.rows[0], makeFile('worksheet.pdf'));

    component.startUpload();

    expect(component.isUploading).toBe(false);
    httpMock.expectNone(UPLOAD_URL);
  });

  it('shows the server error when the upload fails', () => {
    component.setFile(component.rows[0], makeFile('worksheet.pdf'));
    component.setFile(component.rows[1], makeFile('list.cpp'));
    component.setFile(component.rows[2], makeFile('notes.png'));
    component.startUpload();

    httpMock.expectOne(UPLOAD_URL).flush(JSON.stringify({error: 'Submissions are closed'}), {
      status: 403,
      statusText: 'Forbidden',
    });
    vi.advanceTimersByTime(2000);

    expect(component.uploadingInfo.success).toBe(false);
    expect(component.uploadingInfo.error).toBe('Submissions are closed');
  });

  it('passes the support ID on when a network security service blocks the upload', () => {
    const onRequestDenied = vi.fn();
    component.onRequestDenied = onRequestDenied;

    component.setFile(component.rows[0], makeFile('worksheet.pdf'));
    component.setFile(component.rows[1], makeFile('list.cpp'));
    component.setFile(component.rows[2], makeFile('notes.png'));
    component.startUpload();

    httpMock
      .expectOne(UPLOAD_URL)
      .flush(
        '<html>Request Rejected. The requested URL was rejected. Your support ID is 12345</html>',
        {status: 403, statusText: 'Forbidden'},
      );
    vi.advanceTimersByTime(2000);

    expect(onRequestDenied).toHaveBeenCalledWith('12345');
    expect(component.uploadingInfo.success).toBe(false);
  });
});
