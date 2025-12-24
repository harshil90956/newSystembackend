import mongoose from 'mongoose';

const documentSchema = new mongoose.Schema(
  {
    title: { type: String, required: true },
    fileKey: { type: String, required: true },
    fileUrl: { type: String, required: true },
    sourceFileKey: { type: String, default: null },
    sourceMimeType: { type: String, default: null },
    totalPrints: { type: Number, required: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    mimeType: { type: String, default: 'application/pdf' },
    documentType: { type: String, default: 'source' }, // e.g. 'source', 'generated-output'

    colorMode: { type: String, enum: ['RGB', 'CMYK'], default: 'RGB' },
    exportVersion: { type: Number, default: 0 },
    
    // Optional layout support fields for deterministic rendering (backward-compatible)
    objectHeight: { type: Number, optional: true }, // Height of detected object for layout calculations
    seriesBaseOffset: { 
      type: { x: Number, y: Number }, 
      optional: true 
    }, // Base offset for series positioning relative to object
    layoutReferenceVersion: { type: String, optional: true }, // Version identifier for layout algorithm
  },
  { timestamps: true, collection: 'vector_documents' }
);

const VectorDocument = mongoose.models.VectorDocument || mongoose.model('VectorDocument', documentSchema);

export default VectorDocument;
