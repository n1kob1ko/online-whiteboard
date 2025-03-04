import React, { useRef, useState, useEffect, useCallback } from "react";
import {
  Stage,
  Layer,
  Line,
  Rect,
  Circle,
  Ellipse,
  Text,
  Arrow,
  Transformer
} from "react-konva";
import throttle from "lodash.throttle";
import { jsPDF } from "jspdf";

const Whiteboard = () => {
  // Zustände für Zeichenelemente, Zeichnungsstatus und Werkzeuge
  const [elements, setElements] = useState([]);
  const [isDrawing, setIsDrawing] = useState(false);
  // Verfügbare Tools: "pen", "rectangle", "circle", "ellipse", "triangle", "arrow", "text", "sticky", "select", "eraser"
  const [tool, setTool] = useState("pen");
  const [color, setColor] = useState("#000000");
  const [lineWidth, setLineWidth] = useState(3);
  const [fontFamily, setFontFamily] = useState("Arial");
  const [fontStyle, setFontStyle] = useState("normal");
  const [selectedElementId, setSelectedElementId] = useState(null);

  // Neuer Modus-State: "draw" = Zeichnen, "pan" = Verschieben
  const [mode, setMode] = useState("draw");

  // Undo/Redo-Stapel
  const [undoStack, setUndoStack] = useState([]);
  const [redoStack, setRedoStack] = useState([]);

  // Referenzen für Stage, Transformer, Shapes und aktuellen Zeichenpfad
  const stageRef = useRef(null);
  const transformerRef = useRef(null);
  const shapeRefs = useRef({});
  const currentElement = useRef(null);
  const fileInputRef = useRef(null);

  // Client-ID (für Delta-Sync, um eigene Updates zu ignorieren)
  const clientId = useRef(Date.now().toString());

  // WebSocket-Referenz für Echtzeit-Kollaboration
  const socketRef = useRef(null);

  // Hilfsfunktion zur Erzeugung eindeutiger IDs
  const generateId = () => `${Date.now()}-${Math.random()}`;

  // --- WebSocket-Verbindung aufbauen und Delta-Updates empfangen ---
  useEffect(() => {
    socketRef.current = new WebSocket("ws://192.168.0.103:4000");
    socketRef.current.onopen = () => {
      console.log("Mit WebSocket-Server verbunden");
      // Optional: Bei Verbindung kannst du auch einen "full"-Update anfordern.
    };
    
    socketRef.current.onmessage = (event) => {
      const processData = (text) => {
        try {
          const data = JSON.parse(text);
          // Eigene Updates ignorieren
          if (data.clientId === clientId.current) return;
          if (data.type === "add" && data.element) {
            setElements((prev) => [...prev, data.element]);
            console.log("Remote add received:", data);
          } else if (data.type === "update" && data.element) {
            setElements((prev) =>
              prev.map((el) =>
                el.id === data.element.id ? data.element : el
              )
            );
            console.log("Remote update received:", data);
          } else if (data.type === "delete" && data.id) {
            setElements((prev) =>
              prev.filter((el) => el.id !== data.id)
            );
            console.log("Remote delete received:", data);
          } else if (data.type === "full" && data.elements) {
            setElements(data.elements);
            console.log("Remote full update received:", data);
          }
        } catch (err) {
          console.error("Fehler beim Parsen der Nachricht:", err);
        }
      };

      if (event.data instanceof Blob) {
        event.data.text().then(processData);
      } else {
        processData(event.data);
      }
    };

    return () => {
      if (socketRef.current) socketRef.current.close();
    };
  }, []);

  // --- Entferne den useEffect, der früher bei jeder Änderung von "elements" ein Update sendet ---
  // Wir senden Updates jetzt nur als Delta in den spezifischen Event-Handlern.

  // --- Transformer binden ---
  useEffect(() => {
    if (tool === "select" && transformerRef.current) {
      const selectedNode = shapeRefs.current[selectedElementId];
      if (selectedNode) {
        transformerRef.current.nodes([selectedNode]);
        transformerRef.current.getLayer().batchDraw();
      } else {
        transformerRef.current.nodes([]);
      }
    }
  }, [selectedElementId, elements, tool]);

  // --- Throttled-Pointer-Move für kontinuierliche Updates (nur lokal) ---
  const throttledPointerMove = useRef(
    throttle((point) => {
      if (!currentElement.current) return;
      const el = currentElement.current;
      switch (el.type) {
        case "line":
        case "arrow":
          el.points = (Array.isArray(el.points) ? el.points : []).concat([
            point.x,
            point.y
          ]);
          break;
        case "rectangle":
          el.width = point.x - el.x;
          el.height = point.y - el.y;
          break;
        case "circle": {
          const dx = point.x - el.x;
          const dy = point.y - el.y;
          el.radius = Math.sqrt(dx * dx + dy * dy);
          break;
        }
        case "ellipse":
          el.radiusX = Math.abs(point.x - el.x);
          el.radiusY = Math.abs(point.y - el.y);
          break;
        case "triangle": {
          const x1 = el.startX;
          const y1 = el.startY;
          const x2 = point.x;
          const y2 = point.y;
          const leftX = x1;
          const leftY = y2;
          const rightX = x2;
          const rightY = y2;
          const topX = (x1 + x2) / 2;
          const topY = y1;
          el.points = [leftX, leftY, topX, topY, rightX, rightY];
          break;
        }
        default:
          break;
      }
      // Aktualisiere lokalen Zustand
      setElements((prev) => {
        const newElements = [...prev];
        newElements[newElements.length - 1] = { ...el };
        return newElements;
      });
    }, 16)
  ).current;

  // --- Pointer-Down-Handler ---
  const handlePointerDown = (e) => {
    const stage = stageRef.current;
    if (!stage) return;
    const pos = stage.getPointerPosition();
    const transform = stage.getAbsoluteTransform().copy().invert();
    const point = transform.point(pos);
    if (!point) return;

    // Falls im Auswahl- oder Radierer-Modus: Auswahl löschen oder Element löschen
    if (tool === "select" || tool === "eraser") {
      if (e.target === stage) {
        setSelectedElementId(null);
      }
      // Bei Eraser wird das Löschen in onClick des Elements gehandhabt
      return;
    }

    setIsDrawing(true);
    let newElement = null;
    const id = generateId();
    switch (tool) {
      case "pen":
        newElement = {
          id,
          type: "line",
          points: [point.x, point.y],
          color,
          lineWidth
        };
        break;
      case "rectangle":
        newElement = {
          id,
          type: "rectangle",
          x: point.x,
          y: point.y,
          width: 0,
          height: 0,
          color,
          lineWidth
        };
        break;
      case "circle":
        newElement = {
          id,
          type: "circle",
          x: point.x,
          y: point.y,
          radius: 0,
          color,
          lineWidth
        };
        break;
      case "ellipse":
        newElement = {
          id,
          type: "ellipse",
          x: point.x,
          y: point.y,
          radiusX: 0,
          radiusY: 0,
          color,
          lineWidth
        };
        break;
      case "triangle":
        newElement = {
          id,
          type: "triangle",
          startX: point.x,
          startY: point.y,
          points: [point.x, point.y, point.x, point.y, point.x, point.y],
          color,
          lineWidth
        };
        break;
      case "arrow":
        newElement = {
          id,
          type: "arrow",
          points: [point.x, point.y, point.x, point.y],
          color,
          lineWidth
        };
        break;
      default:
        break;
    }
    if (newElement) {
      currentElement.current = newElement;
      setElements((prev) => [...prev, newElement]);
    }
  };

  // --- Pointer-Move-Handler ---
  const handlePointerMove = (e) => {
    if (!isDrawing) return;
    const stage = stageRef.current;
    if (!stage) return;
    const pos = stage.getPointerPosition();
    const transform = stage.getAbsoluteTransform().copy().invert();
    const point = transform.point(pos);
    if (!point) return;
    throttledPointerMove(point);
  };

  // --- Pointer-Up-Handler: Zeichnung abschließen und Delta-Update senden ---
  const handlePointerUp = () => {
    if (isDrawing) {
      setUndoStack((prev) => [...prev, elements]);
      setRedoStack([]);
      if (socketRef.current && socketRef.current.readyState === WebSocket.OPEN) {
        // Sende nur das neu hinzugefügte Element
        const update = { clientId: clientId.current, type: "add", element: currentElement.current };
        socketRef.current.send(JSON.stringify(update));
        console.log("Delta update (add) gesendet:", update);
      }
    }
    setIsDrawing(false);
    currentElement.current = null;
  };

  // --- Funktion zum Aktualisieren eines Elements (z. B. nach Drag/Transform) ---
  const updateElement = (id, newAttrs) => {
    setElements((prev) => {
      const updated = prev.map((el) => (el.id === id ? { ...el, ...newAttrs } : el));
      const updatedElement = updated.find((el) => el.id === id);
      if (
        updatedElement &&
        socketRef.current &&
        socketRef.current.readyState === WebSocket.OPEN
      ) {
        const update = {
          clientId: clientId.current,
          type: "update",
          element: updatedElement
        };
        socketRef.current.send(JSON.stringify(update));
        console.log("Delta update (update) gesendet:", update);
      }
      return updated;
    });
    setUndoStack((prev) => [...prev, elements]);
    setRedoStack([]);
  };

  // --- Rendert alle Elemente inkl. Eventhandler für Auswahl, Drag & Transform ---
  const renderElement = (el, index) => {
    const commonProps = {
      ref: (node) => {
        shapeRefs.current[el.id] = node;
      },
      onClick: (e) => {
        if (tool === "select") {
          setSelectedElementId(el.id);
        }
        if (tool === "eraser") {
          // Lösche Element und sende Delta-Update (delete)
          setElements((prev) => prev.filter((item) => item.id !== el.id));
          if (socketRef.current && socketRef.current.readyState === WebSocket.OPEN) {
            const update = { clientId: clientId.current, type: "delete", id: el.id };
            socketRef.current.send(JSON.stringify(update));
            console.log("Delta update (delete) gesendet:", update);
          }
          setUndoStack((prev) => [...prev, elements]);
          setRedoStack([]);
        }
      },
      draggable: tool === "select",
      onDragEnd: (e) => {
        updateElement(el.id, { x: e.target.x(), y: e.target.y() });
      },
      onTransformEnd: (e) => {
        const node = shapeRefs.current[el.id];
        if (node) {
          const scaleX = node.scaleX();
          const scaleY = node.scaleY();
          node.scaleX(1);
          node.scaleY(1);
          if (el.type === "rectangle" || el.type === "sticky") {
            updateElement(el.id, {
              x: node.x(),
              y: node.y(),
              width: node.width() * scaleX,
              height: node.height() * scaleY
            });
          } else if (el.type === "circle") {
            updateElement(el.id, {
              x: node.x(),
              y: node.y(),
              radius: el.radius * scaleX
            });
          } else if (el.type === "ellipse") {
            updateElement(el.id, {
              x: node.x(),
              y: node.y(),
              radiusX: el.radiusX * scaleX,
              radiusY: el.radiusY * scaleY
            });
          } else if (el.type === "line" || el.type === "arrow") {
            updateElement(el.id, {
              points: el.points
            });
          } else if (el.type === "triangle") {
            updateElement(el.id, {
              points: el.points
            });
          } else if (el.type === "text") {
            updateElement(el.id, {
              x: node.x(),
              y: node.y()
            });
          }
        }
      }
    };

    switch (el.type) {
      case "line":
        return (
          <Line
            key={el.id}
            {...commonProps}
            points={el.points}
            stroke={el.color}
            strokeWidth={el.lineWidth}
            lineCap="round"
            lineJoin="round"
          />
        );
      case "rectangle":
        return (
          <Rect
            key={el.id}
            {...commonProps}
            x={el.x}
            y={el.y}
            width={el.width}
            height={el.height}
            stroke={el.color}
            strokeWidth={el.lineWidth}
          />
        );
      case "circle":
        return (
          <Circle
            key={el.id}
            {...commonProps}
            x={el.x}
            y={el.y}
            radius={el.radius}
            stroke={el.color}
            strokeWidth={el.lineWidth}
          />
        );
      case "ellipse":
        return (
          <Ellipse
            key={el.id}
            {...commonProps}
            x={el.x}
            y={el.y}
            radiusX={el.radiusX}
            radiusY={el.radiusY}
            stroke={el.color}
            strokeWidth={el.lineWidth}
          />
        );
      case "triangle":
        return (
          <Line
            key={el.id}
            {...commonProps}
            points={el.points}
            stroke={el.color}
            strokeWidth={el.lineWidth}
            closed
          />
        );
      case "arrow":
        return (
          <Arrow
            key={el.id}
            {...commonProps}
            points={el.points}
            stroke={el.color}
            fill={el.color}
            strokeWidth={el.lineWidth}
          />
        );
      case "text":
        return (
          <Text
            key={el.id}
            {...commonProps}
            x={el.x}
            y={el.y}
            text={el.text}
            fill={el.color}
            fontSize={el.fontSize}
            fontFamily={el.fontFamily || fontFamily}
            fontStyle={el.fontStyle || fontStyle}
          />
        );
      case "sticky":
        return (
          <React.Fragment key={el.id}>
            <Rect
              {...commonProps}
              x={el.x}
              y={el.y}
              width={el.width}
              height={el.height}
              fill={el.background}
              stroke={el.borderColor}
              strokeWidth={lineWidth}
              cornerRadius={10}
            />
            <Text
              x={el.x + 10}
              y={el.y + 10}
              text={el.text}
              fill="#000000"
              fontSize={el.fontSize}
              width={el.width - 20}
            />
          </React.Fragment>
        );
      default:
        return null;
    }
  };

  // --- Raster und Hilfslinien (Grid) ---
  const Grid = () => {
    const gridSize = 50;
    const width = window.innerWidth - 50;
    const height = 600;
    const lines = [];
    for (let i = gridSize; i < width; i += gridSize) {
      lines.push(
        <Line
          key={`v-${i}`}
          points={[i, 0, i, height]}
          stroke="#ddd"
          strokeWidth={1}
        />
      );
    }
    for (let j = gridSize; j < height; j += gridSize) {
      lines.push(
        <Line
          key={`h-${j}`}
          points={[0, j, width, j]}
          stroke="#ddd"
          strokeWidth={1}
        />
      );
    }
    return <Layer>{lines}</Layer>;
  };

  // --- Wheel-Handler für Zoom ---
  const handleWheel = (e) => {
    e.evt.preventDefault();
    const stage = stageRef.current;
    const oldScale = stage.scaleX();
    const pointer = stage.getPointerPosition();
    const scaleBy = 1.05;
    const newScale = e.evt.deltaY < 0 ? oldScale * scaleBy : oldScale / scaleBy;
    stage.scale({ x: newScale, y: newScale });
    const mousePointTo = {
      x: (pointer.x - stage.x()) / oldScale,
      y: (pointer.y - stage.y()) / oldScale
    };
    const newPos = {
      x: pointer.x - mousePointTo.x * newScale,
      y: pointer.y - mousePointTo.y * newScale
    };
    stage.position(newPos);
    stage.batchDraw();
  };

  // --- Undo-/Redo-Funktionen ---
  const handleUndo = () => {
    if (undoStack.length > 0) {
      const previous = undoStack[undoStack.length - 1];
      setRedoStack((prev) => [...prev, elements]);
      setElements(previous);
      setUndoStack((prev) => prev.slice(0, prev.length - 1));
    }
  };

  const handleRedo = () => {
    if (redoStack.length > 0) {
      const next = redoStack[redoStack.length - 1];
      setUndoStack((prev) => [...prev, elements]);
      setElements(next);
      setRedoStack((prev) => prev.slice(0, prev.length - 1));
    }
  };

  // --- Speichern als JSON ---
  const saveJSON = () => {
    const dataStr = JSON.stringify(elements);
    const blob = new Blob([dataStr], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "whiteboard.json";
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  // --- Laden einer JSON-Datei ---
  const loadJSON = (e) => {
    const file = e.target.files[0];
    if (file) {
      const reader = new FileReader();
      reader.onload = (ev) => {
        try {
          const loadedElements = JSON.parse(ev.target.result);
          setElements(loadedElements);
          setUndoStack((prev) => [...prev, elements]);
          setRedoStack([]);
        } catch (err) {
          alert("Ungültige JSON-Datei");
        }
      };
      reader.readAsText(file);
    }
  };

  // --- Export als PNG ---
  const exportPNG = () => {
    const uri = stageRef.current.toDataURL();
    const link = document.createElement("a");
    link.download = "whiteboard.png";
    link.href = uri;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  // --- Export als PDF ---
  const exportPDF = () => {
    const uri = stageRef.current.toDataURL();
    const pdf = new jsPDF("landscape");
    pdf.addImage(
      uri,
      "PNG",
      0,
      0,
      pdf.internal.pageSize.getWidth(),
      pdf.internal.pageSize.getHeight()
    );
    pdf.save("whiteboard.pdf");
  };

  const toolbarStyle = {
    display: "flex",
    justifyContent: "center",
    gap: "10px",
    padding: "10px",
    flexWrap: "wrap",
    background: "#f5f5f5",
    borderBottom: "1px solid #ccc"
  };

  return (
    <div>
      <div style={toolbarStyle}>
        <button onClick={() => setMode(mode === "draw" ? "pan" : "draw")}>
          {mode === "draw" ? "Pan-Modus" : "Zeichnen"}
        </button>
        <button onClick={() => setTool("pen")}>✏️ Freihand</button>
        <button onClick={() => setTool("rectangle")}>⬛ Rechteck</button>
        <button onClick={() => setTool("circle")}>⚪ Kreis</button>
        <button onClick={() => setTool("ellipse")}>🔵 Ellipse</button>
        <button onClick={() => setTool("triangle")}>🔺 Dreieck</button>
        <button onClick={() => setTool("arrow")}>➡️ Pfeil</button>
        <button onClick={() => setTool("text")}>🔤 Text</button>
        <button onClick={() => setTool("sticky")}>🗒️ Sticky</button>
        <button onClick={() => setTool("select")}>🔍 Auswahl</button>
        <button onClick={() => setTool("eraser")}>❌ Radierer</button>
        <input
          type="color"
          value={color}
          onChange={(e) => setColor(e.target.value)}
        />
        <input
          type="range"
          min="1"
          max="10"
          value={lineWidth}
          onChange={(e) => setLineWidth(Number(e.target.value))}
        />
        <select
          value={fontFamily}
          onChange={(e) => setFontFamily(e.target.value)}
        >
          <option value="Arial">Arial</option>
          <option value="Times New Roman">Times New Roman</option>
          <option value="Courier New">Courier New</option>
        </select>
        <select value={fontStyle} onChange={(e) => setFontStyle(e.target.value)}>
          <option value="normal">Normal</option>
          <option value="bold">Fett</option>
          <option value="italic">Kursiv</option>
        </select>
        <button onClick={handleUndo}>↩️ Undo</button>
        <button onClick={handleRedo}>↪️ Redo</button>
        <button onClick={saveJSON}>💾 Save JSON</button>
        <button onClick={() => fileInputRef.current.click()}>
          📂 Load JSON
        </button>
        <button onClick={exportPNG}>🖼️ Export PNG</button>
        <button onClick={exportPDF}>📄 Export PDF</button>
        <button onClick={() => setElements([])}>🗑️ Clear</button>
        <input
          type="file"
          ref={fileInputRef}
          style={{ display: "none" }}
          onChange={loadJSON}
          accept=".json"
        />
      </div>
      <Stage
        width={window.innerWidth}
        height={window.innerHeight - 100}
        draggable={mode === "pan"}
        onPointerDown={mode === "draw" ? handlePointerDown : undefined}
        onPointerMove={mode === "draw" ? handlePointerMove : undefined}
        onPointerUp={mode === "draw" ? handlePointerUp : undefined}
        onWheel={handleWheel}
        ref={stageRef}
        style={{
          border: "1px solid #ccc",
          margin: "auto",
          display: "block",
          touchAction: "none"
        }}
      >
        <Grid />
        <Layer>
          {elements.map((el, i) => renderElement(el, i))}
          {tool === "select" && <Transformer ref={transformerRef} />}
        </Layer>
      </Stage>
    </div>
  );
};

export default Whiteboard;
