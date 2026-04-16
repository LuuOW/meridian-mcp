---
name: computer-vision
description: Computer vision engineering covering object detection (YOLO, RT-DETR), instance and semantic segmentation (SAM, Mask R-CNN), image classification, OCR (Tesseract, PaddleOCR), video understanding, OpenCV pipelines, PyTorch/torchvision, ONNX export, and edge deployment via TensorRT and CoreML.
orb_class: planet
keywords: ["computer-vision", "yolo", "rt-detr", "sam", "mask-rcnn", "object-detection", "segmentation", "ocr", "tesseract", "paddleocr", "opencv", "torchvision", "onnx", "tensorrt", "coreml", "image-classification", "video-understanding", "edge-deployment", "albumentations", "roboflow"]
---

# Computer Vision

Computer vision is the engineering discipline of making machines interpret and act on visual data — images, video, point clouds, and multi-modal streams. This skill spans the full pipeline from raw pixel ingestion through model training, evaluation, export, and production deployment, with emphasis on the practical trade-offs between accuracy, latency, and hardware constraints. Canonical frameworks are PyTorch/torchvision, Ultralytics, OpenCV, and the ONNX ecosystem.

## Core Concepts

### Object Detection

**YOLOv8 / YOLOv11 (Ultralytics)** is the workhorse for real-time detection. Training: `model = YOLO('yolov8n.pt'); model.train(data='dataset.yaml', epochs=100, imgsz=640, batch=16, device='cuda')`. Dataset YAML format: `path`, `train`, `val`, `nc` (num classes), `names`. Key hyperparameters: `mosaic` augmentation (default on, disable last 10 epochs via `close_mosaic=10`), `mixup`, `degrees`, `hsv_h/s/v`. For small objects, use a higher `imgsz` (1280) and anchor-free head benefits directly. Export: `model.export(format='onnx', opset=17, dynamic=True)` or `format='engine'` for TensorRT.

**RT-DETR** (Real-Time Detection Transformer) from Baidu: eliminates NMS via set-based prediction, so latency is more deterministic. Use `RTDETRv2` via Ultralytics or the original PaddleDetection implementation. Backbone is typically ResNet-50/101 or HGNetv2. Slower to train than YOLO but competitive accuracy at similar FPS on GPU. Good choice when NMS jitter causes downstream tracking instability.

NMS tuning: `conf` threshold (default 0.25 for inference, raise to 0.5+ for precision-sensitive tasks), `iou` threshold (default 0.7 for NMS suppression). `agnostic_nms=True` suppresses across classes — useful when class overlap is likely (e.g., person vs. cyclist partially occluded).

**COCO metrics**: report mAP@0.5 and mAP@0.5:0.95. The latter is the standard benchmark metric; @0.5 is more forgiving. Per-class AP breakdown often reveals dataset imbalance issues before overall mAP does.

### Segmentation

**SAM (Segment Anything Model)** from Meta: prompt-based segmentation — points, boxes, or masks as prompts. Use `SamPredictor` for interactive use (single image, multiple prompts) or `SamAutomaticMaskGenerator` for dense everything-segmentation. SAM 2 extends to video with memory attention across frames. Key gotcha: SAM generates masks but not class labels — pair with a classifier or detection model for semantic meaning. FastSAM and MobileSAM are distilled versions for edge use.

**Mask R-CNN** (torchvision): `torchvision.models.detection.maskrcnn_resnet50_fpn(weights='DEFAULT')`. Fine-tune by replacing the head: `model.roi_heads.box_predictor = FastRCNNPredictor(in_features, num_classes)` and `model.roi_heads.mask_predictor = MaskRCNNPredictor(in_features_mask, 256, num_classes)`. Outputs: `boxes`, `labels`, `scores`, `masks` (soft masks, threshold at 0.5). FPN (Feature Pyramid Network) handles multi-scale objects natively.

**Semantic segmentation**: SegFormer (Hugging Face `transformers`) is the modern choice — transformer encoder + lightweight MLP decoder. DeepLabV3+ (torchvision) remains strong for edge cases needing ASPP multi-scale context. Loss: combine CrossEntropyLoss with DiceLoss for class-imbalanced datasets (background dominates).

### Image Classification

Standard pipeline: `torchvision.transforms.v2` for augmentation (preferred over v1 — supports batched transforms and bounding boxes in the same pipeline). Use `AutoAugment` or `RandAugment` for regularization. Fine-tuning: freeze backbone, train head for 5 epochs, then unfreeze and train with 10x lower LR (`differential_lr` pattern). `timm` (PyTorch Image Models) is the canonical model zoo — `timm.create_model('convnextv2_base', pretrained=True, num_classes=N)`. For class imbalance: `WeightedRandomSampler` in the DataLoader or focal loss.

### OCR

**Tesseract**: wrap with `pytesseract`. Preprocessing matters enormously — binarize with adaptive thresholding (`cv2.adaptiveThreshold`), deskew (Hough line detection), and denoise before passing to Tesseract. `--psm` (page segmentation mode): 6 for uniform block of text, 7 for single line, 11 for sparse text. `--oem 3` for LSTM engine. Custom training with `tesstrain` on domain-specific fonts (legal, handwriting) significantly outperforms the default model.

**PaddleOCR**: two-stage pipeline — text detection (DB or EAST) + text recognition (CRNN/SVTR). `PaddleOCR(use_angle_cls=True, lang='en')`. More accurate than Tesseract on natural scene text and rotated/curved text. Use `det=True, rec=True, cls=True` for full pipeline. Export to ONNX for framework-agnostic deployment.

**EasyOCR** is a simpler wrapper (80+ languages) suitable for prototyping. For production with strict latency SLAs, prefer PaddleOCR or a fine-tuned TrOCR (transformer-based, Hugging Face).

### OpenCV Pipelines

Core operations: `cv2.imread` (returns BGR, not RGB — always convert with `cv2.cvtColor(img, cv2.COLOR_BGR2RGB)` before passing to PyTorch), `cv2.resize` with `cv2.INTER_AREA` for downscaling (sharpest) and `cv2.INTER_LINEAR` for upscaling. Blob detection: `cv2.SimpleBlobDetector` with `SimpleBlobDetector_Params`. Contour pipeline: `cv2.Canny` → `cv2.findContours` → `cv2.contourArea` filter → `cv2.boundingRect`. Optical flow: `cv2.calcOpticalFlowPyrLK` (sparse, Lucas-Kanade) or `cv2.calcOpticalFlowFarneback` (dense). Video capture: always check `cap.isOpened()` and handle `ret=False` frames gracefully — network cameras drop frames.

### Video Understanding

**Temporal models**: SlowFast (two-pathway: slow for spatial, fast for motion), VideoMAE (masked autoencoder pre-training on video), and TimeSformer (divided space-time attention). For action recognition, 8 or 16 uniformly sampled frames per clip is the standard input. Use decord library for efficient random-access video decoding (much faster than OpenCV for non-sequential access).

**Tracking**: ByteTrack and BoT-SORT are the current leaders for multi-object tracking (MOT). Ultralytics integrates ByteTrack directly: `model.track(source='video.mp4', tracker='bytetrack.yaml')`. Key metrics: HOTA (higher-order tracking accuracy), MOTA (multi-object tracking accuracy), IDF1.

### ONNX Export and Runtime

Export from PyTorch: `torch.onnx.export(model, dummy_input, 'model.onnx', opset_version=17, input_names=['input'], output_names=['output'], dynamic_axes={'input': {0: 'batch_size'}})`. Validate with `onnx.checker.check_model(onnx.load('model.onnx'))`. Run with `onnxruntime`: `sess = ort.InferenceSession('model.onnx', providers=['CUDAExecutionProvider', 'CPUExecutionProvider'])`. Always specify provider priority list — falls back gracefully. Use `ort.SessionOptions` with `graph_optimization_level=ort.GraphOptimizationLevel.ORT_ENABLE_ALL`.

Gotcha: operations like `torch.nn.functional.grid_sample` (used in deformable convolutions and some attention mechanisms) may not export cleanly to all ONNX opsets — test with `onnxruntime` immediately after export, not just `onnx.checker`.

### Edge Deployment

**TensorRT**: convert from ONNX with `trtexec --onnx=model.onnx --saveEngine=model.trt --fp16`. For Python: use `tensorrt` SDK — `trt.Builder` → `builder.build_serialized_network`. INT8 quantization requires a calibration dataset (`IInt8EntropyCalibrator2`). Use `trt.Runtime` with a CUDA stream for async inference. Memory: allocate device buffers with `cuda.mem_alloc`, use `cuda.memcpy_htod_async` / `cuda.memcpy_dtoh_async`. TensorRT engines are device-specific — an engine built on an A100 will not run on a T4. Always build on the target hardware in CI.

**CoreML** (Apple Silicon / iOS): convert from PyTorch via `coremltools`: `ct.convert(traced_model, inputs=[ct.ImageType(name='input', shape=(1,3,640,640))], compute_precision=ct.precision.FLOAT16)`. Use `ct.ComputeUnit.ALL` to target Neural Engine + GPU. The Neural Engine only supports a subset of ops — verify with `coremltools.optimize.coreml`. On-device fine-tuning (iOS 17+) is possible via `MLUpdateTask` for personalization use cases.

### Data Augmentation and Dataset Management

**Albumentations** is faster than torchvision transforms for augmentation-heavy pipelines (SIMD-optimized). `A.Compose([A.HorizontalFlip(), A.RandomBrightnessContrast(), A.Normalize(...), ToTensorV2()])` with `bbox_params=A.BboxParams(format='yolo')` for detection. Use `A.OneOf` for randomly selected augmentation branches.

**Roboflow** / **FiftyOne** for dataset curation — FiftyOne's brain module (`fo.brain.compute_uniqueness`, `compute_similarity`) identifies near-duplicates and hard negatives without manual review. Label quality check with `fo.utils.quality` catches annotation errors before training.
