{{- define "apg.name" -}}
{{- .Chart.Name | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "apg.fullname" -}}
{{- if contains .Chart.Name .Release.Name -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name .Chart.Name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}

{{- define "apg.labels" -}}
app.kubernetes.io/name: {{ include "apg.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version }}
{{- end -}}

{{- define "apg.selector" -}}
app.kubernetes.io/name: {{ include "apg.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{- define "apg.secretName" -}}
{{- default (printf "%s-secrets" (include "apg.fullname" .)) .Values.secrets.existingSecret -}}
{{- end -}}

{{- define "apg.serviceAccountName" -}}
{{- if .Values.serviceAccount.create -}}
{{- default (include "apg.fullname" .) .Values.serviceAccount.name -}}
{{- else -}}
{{- default "default" .Values.serviceAccount.name -}}
{{- end -}}
{{- end -}}

{{/*
The pod template of a node. Called with a dict: root (the chart context),
track ("stable" or "canary") and tag (the image tag).
*/}}
{{- define "apg.nodePod" -}}
metadata:
  labels:
    {{- include "apg.selector" .root | nindent 4 }}
    app.kubernetes.io/component: node
    apg/track: {{ .track }}
  {{- with .root.Values.node.podAnnotations }}
  annotations:
    {{- toYaml . | nindent 4 }}
  {{- end }}
spec:
  serviceAccountName: {{ include "apg.serviceAccountName" .root }}
  terminationGracePeriodSeconds: {{ .root.Values.node.terminationGracePeriodSeconds }}
  {{- with .root.Values.imagePullSecrets }}
  imagePullSecrets:
    {{- toYaml . | nindent 4 }}
  {{- end }}
  securityContext:
    runAsNonRoot: true
    runAsUser: 10001
    fsGroup: 10001
    seccompProfile: { type: RuntimeDefault }
  containers:
    - name: node
      image: "{{ .root.Values.image.node.repository }}:{{ .tag }}"
      imagePullPolicy: {{ .root.Values.image.pullPolicy }}
      securityContext:
        allowPrivilegeEscalation: false
        readOnlyRootFilesystem: true
        capabilities: { drop: [ALL] }
      env:
        - name: APG_CONFIG_SOURCE
          value: api_poll
        - name: APG_CONFIG_URL
          value: "http://{{ include "apg.fullname" .root }}-admin:{{ .root.Values.admin.service.port }}/dp"
        # Each pod is one node to the control plane.
        - name: APG_NODE_ID
          valueFrom: { fieldRef: { fieldPath: metadata.name } }
        - name: APG_NODE_TOKEN
          valueFrom: { secretKeyRef: { name: {{ include "apg.secretName" .root }}, key: node-token } }
        - name: APG_SECRET_KEY
          valueFrom: { secretKeyRef: { name: {{ include "apg.secretName" .root }}, key: secret-key } }
        - name: APG_HTTP_MODE
          value: {{ .root.Values.node.httpMode | quote }}
        - name: APG_SHUTDOWN_GRACE_SECS
          value: {{ sub (int .root.Values.node.terminationGracePeriodSeconds) 10 | quote }}
        {{- with .root.Values.node.region }}
        - name: APG_REGION
          value: {{ . | quote }}
        {{- end }}
        {{- range $name, $value := .root.Values.node.env }}
        - name: {{ $name }}
          value: {{ $value | quote }}
        {{- end }}
      ports:
        - { name: https, containerPort: 8443 }
        - { name: http, containerPort: 8080 }
        - { name: mgmt, containerPort: 9100 }
      # Ready means: holds a complete configuration. It does not mean the
      # control plane is reachable; a node keeps serving through its outage.
      readinessProbe:
        httpGet: { path: /readyz, port: mgmt }
        periodSeconds: 5
        failureThreshold: 3
      livenessProbe:
        httpGet: { path: /healthz, port: mgmt }
        periodSeconds: 10
        failureThreshold: 6
      startupProbe:
        httpGet: { path: /healthz, port: mgmt }
        periodSeconds: 2
        failureThreshold: 30
      resources:
        {{- toYaml .root.Values.node.resources | nindent 8 }}
      volumeMounts:
        - { name: cache, mountPath: /var/lib/apg }
  volumes:
    - name: cache
      emptyDir:
        sizeLimit: {{ .root.Values.node.cache.sizeLimit }}
  {{- with .root.Values.node.nodeSelector }}
  nodeSelector:
    {{- toYaml . | nindent 4 }}
  {{- end }}
  {{- with .root.Values.node.tolerations }}
  tolerations:
    {{- toYaml . | nindent 4 }}
  {{- end }}
  {{- with .root.Values.node.affinity }}
  affinity:
    {{- toYaml . | nindent 4 }}
  {{- end }}
  {{- with .root.Values.node.topologySpreadConstraints }}
  topologySpreadConstraints:
    {{- toYaml . | nindent 4 }}
  {{- end }}
{{- end -}}
