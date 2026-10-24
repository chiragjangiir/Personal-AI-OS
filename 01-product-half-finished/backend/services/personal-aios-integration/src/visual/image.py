"""CPU image boundary: one decode, optional YuNet/SFace, binary thumbnail/signature output."""
import json
import sys
import os
import struct
os.environ['OPENCV_IO_MAX_IMAGE_PIXELS'] = '4194304'
os.environ['OPENCV_IO_MAX_IMAGE_WIDTH'] = '4096'
os.environ['OPENCV_IO_MAX_IMAGE_HEIGHT'] = '4096'
import cv2
import numpy as np
cv2.setNumThreads(1)
data = sys.stdin.buffer.read(3 * 1024 * 1024 + 1)
if len(data) > 3 * 1024 * 1024:
    raise ValueError('VISUAL_IMAGE_TOO_LARGE')
image = cv2.imdecode(np.frombuffer(data, dtype=np.uint8), cv2.IMREAD_COLOR)
if image is None:
    raise ValueError('VISUAL_IMAGE_INVALID')
height, width = image.shape[:2]
if max(height, width) > 4096 or height * width > 4194304:
    raise ValueError('VISUAL_IMAGE_TOO_LARGE')
ratio = min(1, 320 / max(height, width))
small = cv2.resize(image, (max(1, round(width * ratio)), max(1, round(height * ratio))), interpolation=cv2.INTER_AREA)
for quality in (80, 70, 60, 50, 40, 30, 20, 10):
    success, thumbnail = cv2.imencode('.jpg', small, [cv2.IMWRITE_JPEG_QUALITY, quality])
    if not success:
        raise ValueError('VISUAL_IMAGE_INVALID')
    if len(thumbnail) <= 20480:
        break
signature = cv2.resize(cv2.cvtColor(image, cv2.COLOR_BGR2GRAY), (8, 8), interpolation=cv2.INTER_AREA)
result = []
if len(sys.argv) == 4:
    detector = cv2.FaceDetectorYN.create(sys.argv[2], '', (width, height), 0.9, 0.3, 5000,
                                       cv2.dnn.DNN_BACKEND_OPENCV, cv2.dnn.DNN_TARGET_CPU)
    _, faces = detector.detect(image)
    if faces is not None and len(faces):
        recognizer = cv2.FaceRecognizerSF.create(sys.argv[3], '', cv2.dnn.DNN_BACKEND_OPENCV, cv2.dnn.DNN_TARGET_CPU)
        for face in faces:
            feature = recognizer.feature(recognizer.alignCrop(image, face)).reshape(-1)
            norm = np.linalg.norm(feature)
            result.append({'embedding': (feature / norm).tolist(), 'bbox': face[:4].tolist(), 'confidence': float(face[14])})
header = json.dumps({'faces': result}, allow_nan=False).encode()
sys.stdout.buffer.write(struct.pack('>I', len(header)) + header + signature.tobytes() + thumbnail.tobytes())
